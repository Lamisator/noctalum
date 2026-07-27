// noctalum-wsjtx bridges WSJT-X to a remote Noctalum server.  It logs in
// with username/password, lets the operator pick a contest, then listens
// on UDP for WSJT-X LOG_QSO messages and posts each one to the server.
//
// QSOs survive network outages: every incoming datagram is written to a
// per-user JSON outbox on disk before the first send attempt, and a
// background retry loop drains the outbox with exponential backoff.  A
// process restart picks up whatever hadn't yet been delivered.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/noctalum/noctalum/internal/wsjtx"
	"golang.org/x/term"
)

type contest struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	StationCall string `json:"station_call"`
	Status      string `json:"status"`
}

const (
	baseRetryInterval = 5 * time.Second
	maxRetryInterval  = 5 * time.Minute
)

// bridge bundles the CLI's runtime state so the retry goroutine, the
// UDP listener, and the auth calls can all reach it without passing a
// hairy tuple of arguments around.
type bridge struct {
	server   string
	forceDup bool

	mu   sync.Mutex
	hc   *http.Client
	csrf string

	outbox         *wsjtx.Outbox
	pendingChanged chan struct{}
}

func main() {
	serverFlag := flag.String("server", "http://localhost:8080", "Noctalum server URL")
	userFlag := flag.String("user", "", "username — required")
	passFlag := flag.String("pass", "", "password (omit to be prompted)")
	udpFlag := flag.String("udp", "0.0.0.0:2237", "UDP address to listen for WSJT-X messages")
	forceDupFlag := flag.Bool("force-dup", false, "submit QSOs even if the server flags them as duplicates")
	outboxPathFlag := flag.String("outbox", "", "path to the persistent QSO queue (default: per-user config dir)")
	flag.Parse()

	if *userFlag == "" {
		fmt.Fprintln(os.Stderr, "error: -user is required")
		flag.Usage()
		os.Exit(1)
	}

	server := *serverFlag
	if !strings.HasPrefix(server, "http://") && !strings.HasPrefix(server, "https://") {
		server = "https://" + server
	}

	pass := *passFlag
	if pass == "" {
		fmt.Fprint(os.Stderr, "Password: ")
		pBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			log.Fatalf("read password: %v", err)
		}
		pass = string(pBytes)
	}

	jar, _ := cookiejar.New(nil)
	b := &bridge{
		server:         server,
		forceDup:       *forceDupFlag,
		hc:             &http.Client{Jar: jar, Timeout: 15 * time.Second},
		pendingChanged: make(chan struct{}, 1),
	}

	// Open the outbox before login so an unreachable server on startup
	// (e.g. laptop still tethering) doesn't cost us the state from a
	// prior run.  Login can be retried in a future invocation; the
	// operator's already-logged QSOs cannot.
	obPath := *outboxPathFlag
	if obPath == "" {
		obPath = defaultOutboxPath()
	}
	ob, err := wsjtx.LoadOutbox(obPath)
	if err == wsjtx.ErrOutboxCorrupt {
		log.Printf("warning: on-disk outbox at %s was corrupt — old file renamed with .corrupt-* suffix", obPath)
	} else if err != nil {
		log.Printf("warning: outbox persistence disabled (%v) — QSOs will be kept in memory only", err)
		ob = &wsjtx.Outbox{}
	}
	b.outbox = ob
	if n := b.outbox.Len(); n > 0 {
		log.Printf("outbox: loaded %d pending QSO(s) from %s — will retry after login", n, obPath)
	}

	if err := b.login(*userFlag, pass); err != nil {
		log.Fatalf("login failed: %v", err)
	}
	log.Printf("logged in as %s", *userFlag)

	contests, err := b.getContests()
	if err != nil {
		log.Fatalf("list contests: %v", err)
	}
	if len(contests) == 0 {
		log.Fatal("no contests found on server — create one first via the web UI")
	}

	contestID := pickContest(contests)
	if err := b.selectContest(contestID); err != nil {
		log.Fatalf("select contest: %v", err)
	}
	log.Printf("contest selected; listening for WSJT-X on %s", *udpFlag)

	pc, err := listenUDP(*udpFlag)
	if err != nil {
		log.Fatalf("udp listen: %v", err)
	}
	defer pc.Close()

	// Graceful shutdown on SIGINT / SIGTERM so tail-piped logs
	// terminate cleanly and the retry goroutine gets a chance to save
	// any in-flight outbox mutation.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Retry goroutine: drains the outbox on a timer + on-poke, with
	// exponential backoff during outages.  Nothing else in this
	// program talks to the server for QSO submission.
	go b.retryLoop(ctx)
	b.pokeRetry() // flush anything the previous run left behind

	// Main UDP loop: parse LOG_QSO datagrams, enqueue, poke retry.
	// The short read deadline lets ctx cancellation fire promptly.
	buf := make([]byte, 65535)
	for {
		select {
		case <-ctx.Done():
			log.Printf("shutting down (%d QSO(s) still in outbox)", b.outbox.Len())
			return
		default:
		}
		_ = pc.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			log.Printf("udp read: %v", err)
			continue
		}
		msg, err := wsjtx.ParseLogQSO(buf[:n])
		if err != nil {
			continue // not a LOG_QSO packet, silently ignore
		}
		b.enqueueQSO(msg)
	}
}

// ── outbox path ─────────────────────────────────────────────────────────

// defaultOutboxPath picks a per-user location that mirrors the GUI's
// wsjtx-outbox.json (same Noctalum config dir per OS).  The CLI file has
// a distinct name so running the CLI and the GUI side-by-side against
// different servers doesn't mix their queues.
func defaultOutboxPath() string {
	var dir string
	switch runtime.GOOS {
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, "Library", "Application Support", "Noctalum")
		}
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			dir = filepath.Join(v, "Noctalum")
		}
	default:
		if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
			dir = filepath.Join(v, "Noctalum")
		} else if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, ".config", "Noctalum")
		}
	}
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "wsjtx-cli-outbox.json")
}

// ── auth ────────────────────────────────────────────────────────────────

// login authenticates and stashes the CSRF token for later POSTs.
func (b *bridge) login(user, pass string) error {
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := b.hc.Post(b.server+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpError(resp)
	}
	var out struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("decode login response: %w", err)
	}
	if out.CSRFToken == "" {
		return fmt.Errorf("no csrf_token in response")
	}
	b.mu.Lock()
	b.csrf = out.CSRFToken
	b.mu.Unlock()
	return nil
}

func (b *bridge) getContests() ([]contest, error) {
	resp, err := b.hc.Get(b.server + "/api/contests")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, httpError(resp)
	}
	var out []contest
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

func (b *bridge) selectContest(id int64) error {
	u := fmt.Sprintf("%s/api/contests/%d/select", b.server, id)
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader([]byte("{}")))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	b.mu.Lock()
	req.Header.Set("X-CSRF-Token", b.csrf)
	b.mu.Unlock()
	resp, err := b.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpError(resp)
	}
	return nil
}

// ── outbox integration ──────────────────────────────────────────────────

// enqueueQSO turns a parsed WSJT-X datagram into an OutboxItem, writes
// it to disk, and pokes the retry loop.  The one-line log records the
// fact so the operator sees per-QSO activity even during an outage,
// paired with a "queue: N pending" summary line when the count changes.
func (b *bridge) enqueueQSO(m *wsjtx.LogQSO) {
	payload := map[string]any{
		"callsign":     strings.ToUpper(strings.TrimSpace(m.DxCall)),
		"freq_hz":      int64(m.DialFrequency),
		"mode":         m.Mode,
		"rst_sent":     strings.TrimSpace(m.ReportSent),
		"rst_received": strings.TrimSpace(m.ReportReceived),
		"locator":      strings.ToUpper(strings.TrimSpace(m.DxGrid)),
		"time":         m.Time().Format(time.RFC3339),
	}
	if notes := m.Notes(); notes != "" {
		payload["notes"] = notes
	}
	body, _ := json.Marshal(payload)
	item := &wsjtx.OutboxItem{
		Endpoint: "/api/qsos",
		Body:     body,
		Callsign: m.DxCall,
		Mode:     m.Mode,
		MyCall:   m.MyCall,
		ForceDup: b.forceDup,
	}
	if err := b.outbox.Add(item); err != nil {
		log.Printf("warning: outbox persistence failed (%v) — sending in-memory only", err)
	}
	log.Printf("queued: %-12s  %-8s  sent=%-4s  rcvd=%s  (queue=%d)",
		m.DxCall, m.Mode, m.ReportSent, m.ReportReceived, b.outbox.Len())
	b.pokeRetry()
}

// pokeRetry wakes the retry goroutine immediately.
func (b *bridge) pokeRetry() {
	select {
	case b.pendingChanged <- struct{}{}:
	default:
	}
}

// retryLoop is the single point that POSTs to the server.  Exponential
// backoff (5 s → 5 min cap) between failing waves keeps a long outage
// from hammering the network; the backoff resets to 5 s the moment a
// wave succeeds or a fresh item pokes us.
func (b *bridge) retryLoop(ctx context.Context) {
	interval := baseRetryInterval
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.pendingChanged:
			interval = baseRetryInterval
		case <-time.After(interval):
		}
		if b.outbox.Len() == 0 {
			interval = baseRetryInterval
			continue
		}
		succeeded, tried := b.flushOutbox()
		if tried == 0 {
			continue
		}
		if succeeded == tried {
			interval = baseRetryInterval
		} else {
			interval *= 2
			if interval > maxRetryInterval {
				interval = maxRetryInterval
			}
		}
	}
}

// flushOutbox drains a snapshot of the queue.  Stops on the first
// retriable failure — no point spamming a down server with the whole
// queue when the next attempt will hit the same wall.
func (b *bridge) flushOutbox() (succeeded, tried int) {
	snap := b.outbox.Snapshot()
	for i := range snap {
		it := snap[i]
		result, msg := b.trySendItem(&it)
		tried++
		switch result {
		case wsjtx.SendOK:
			_ = b.outbox.Remove(it.ID)
			log.Printf("sent:   %-12s  %-8s  (queue=%d)", it.Callsign, it.Mode, b.outbox.Len())
			succeeded++
		case wsjtx.SendDrop:
			_ = b.outbox.Remove(it.ID)
			log.Printf("dropped: %-12s  %-8s  — %s  (queue=%d)", it.Callsign, it.Mode, msg, b.outbox.Len())
			succeeded++ // a drop isn't a network failure; don't grow backoff
		case wsjtx.SendRetry:
			_ = b.outbox.UpdateError(it.ID, msg)
			// Log once per wave, not once per remaining item, so an
			// outage produces one line every backoff tick instead of
			// N.  The remaining items are still queued and will
			// retry together on the next tick.
			log.Printf("retry:  %-12s  %-8s  — %s  (queue=%d)", it.Callsign, it.Mode, msg, b.outbox.Len())
			return
		}
	}
	return
}

// trySendItem POSTs one item and classifies the outcome.  Auth is
// attached from the current session state, not from anything persisted
// on the item, so re-auth (e.g. a future --resume mode) picks up the
// queue transparently.
func (b *bridge) trySendItem(item *wsjtx.OutboxItem) (wsjtx.SendResult, string) {
	url := b.server + item.Endpoint
	if item.ForceDup {
		url += "?force=1"
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(item.Body))
	if err != nil {
		return wsjtx.SendDrop, err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	b.mu.Lock()
	csrf := b.csrf
	b.mu.Unlock()
	if csrf == "" {
		return wsjtx.SendRetry, "not logged in"
	}
	req.Header.Set("X-CSRF-Token", csrf)

	resp, err := b.hc.Do(req)
	if err != nil {
		return wsjtx.SendRetry, err.Error()
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated:
		return wsjtx.SendOK, ""
	case http.StatusConflict:
		return wsjtx.SendDrop, "duplicate (use -force-dup to override)"
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return wsjtx.SendDrop, httpErrorMessage(resp)
	default:
		// 401/403 (auth), 5xx (server transient), anything else —
		// treat as retriable so a bounced server or a fresh login
		// recovers automatically.
		return wsjtx.SendRetry, httpErrorMessage(resp)
	}
}

// ── UDP + helpers ───────────────────────────────────────────────────────

// pickContest prints the contest list and prompts the operator to choose one.
func pickContest(contests []contest) int64 {
	fmt.Println("\nAvailable contests:")
	for i, c := range contests {
		fmt.Printf("  [%d] %s  (%s)  status: %s\n", i+1, c.Name, c.StationCall, c.Status)
	}
	r := bufio.NewReader(os.Stdin)
	for {
		fmt.Print("Select contest [1]: ")
		line, _ := r.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return contests[0].ID
		}
		n, err := strconv.Atoi(line)
		if err == nil && n >= 1 && n <= len(contests) {
			return contests[n-1].ID
		}
		fmt.Printf("  please enter a number between 1 and %d\n", len(contests))
	}
}

// listenUDP opens a UDP listener; automatically joins multicast group if
// the address is a multicast IP (e.g. 224.0.0.1:2237, the WSJT-X default).
func listenUDP(addr string) (net.PacketConn, error) {
	udpAddr, err := net.ResolveUDPAddr("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", addr, err)
	}
	if udpAddr.IP != nil && udpAddr.IP.IsMulticast() {
		conn, err := net.ListenMulticastUDP("udp4", nil, udpAddr)
		if err != nil {
			return nil, fmt.Errorf("multicast listen %s: %w", addr, err)
		}
		return conn, nil
	}
	return net.ListenPacket("udp4", addr)
}

func httpError(resp *http.Response) error {
	return errors.New(httpErrorMessage(resp))
}

func httpErrorMessage(resp *http.Response) string {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&e)
	if e.Error != "" {
		return fmt.Sprintf("HTTP %d: %s", resp.StatusCode, e.Error)
	}
	return fmt.Sprintf("HTTP %d", resp.StatusCode)
}
