package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/noctalum/noctalum/internal/wsjtx"
)

// contest is one row of the /api/contests response — the bridge only
// needs the display fields for the picker plus the id.
type contest struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	StationCall string `json:"station_call"`
	Status      string `json:"status"`
}

// qsoResult is emitted for every LOG_QSO datagram the bridge processes,
// whether or not the server accepted it.  The UI turns it into an
// Activity-log line.
type qsoResult struct {
	Item    *wsjtx.OutboxItem
	Kind    qsoResultKind
	Err     string
}

type qsoResultKind int

const (
	qsoQueued  qsoResultKind = iota // just arrived, in outbox awaiting first attempt
	qsoSent                          // outbox item confirmed by server
	qsoSkipped                       // client-side MyCall filter dropped it, never posted
	qsoDropped                       // POSTed but server rejected in a non-retriable way
	qsoRetry                         // last attempt failed with a retriable error
)

// listenerEvent groups the messages a running session emits back to the UI
// over a Go channel.  The channel is unbuffered but the UI reads it on a
// tight `select` loop wrapped in fyne's queue, so drops shouldn't happen
// in practice.
type listenerEvent struct {
	Kind    string // "log", "qso", "listening", "stopped", "error", "queue"
	Message string
	Result  *qsoResult
	Pending int // for Kind=="queue": current outbox length
}

// session is the long-lived state that drives one WSJT-X → Noctalum
// bridge instance.  It's constructed empty and gains fields as the
// operator progresses through the flow (login → contest → listen), so
// the same struct works for both auth modes.
type session struct {
	mu sync.Mutex

	// Common
	serverBase string       // "https://host[:port]", never trailing slash
	hc         *http.Client // shared cookie jar (used only in password mode)

	// Password mode
	csrfToken string
	loggedIn  bool

	// Token mode
	helperToken      string
	tokenContestID   int64
	tokenStationCall string // may be empty for pre-v0.76 tokens

	// Runtime
	events chan listenerEvent
	cancel context.CancelFunc
	pc     net.PacketConn

	// Persistent QSO queue.  Set once at construction and reused for
	// the process lifetime; the retry loop drains it whenever the
	// server is reachable, so a network outage cannot cost the operator
	// any QSO WSJT-X already reported.
	outbox         *wsjtx.Outbox
	pendingChanged chan struct{}
	retryCancel    context.CancelFunc
}

// newSession opens the persistent outbox (or falls back to an in-memory
// one on filesystem errors), spawns the retry loop, and returns a ready
// session.  The retry loop runs for the process lifetime because the
// outbox may already contain items from a prior run — we want them to
// flush as soon as the operator gives us a server.
func newSession() *session {
	jar, _ := cookiejar.New(nil)
	s := &session{
		hc:             &http.Client{Jar: jar, Timeout: 15 * time.Second},
		events:         make(chan listenerEvent, 64),
		pendingChanged: make(chan struct{}, 1),
	}

	// Store the outbox alongside the credentials file — same per-OS
	// config dir, same 0600 permissions.  A missing directory is fine;
	// LoadOutbox / MkdirAll will create it on first Add.
	obPath := filepath.Join(filepath.Dir(credentialsPath()), "wsjtx-outbox.json")
	ob, err := wsjtx.LoadOutbox(obPath)
	if err == wsjtx.ErrOutboxCorrupt {
		// Non-fatal: LoadOutbox has already renamed the bad file and
		// returned an empty (but usable) outbox.  The UI will note it
		// once the event pump comes online.
		go func() {
			s.events <- listenerEvent{Kind: "log",
				Message: "warning: on-disk outbox was corrupt — old file renamed with .corrupt-* suffix"}
		}()
	} else if err != nil {
		// Filesystem is unwritable — fall back to an unpersisted queue
		// so at least in-memory retries still work.  We surface the
		// error once so the operator knows persistence is off.
		go func() {
			s.events <- listenerEvent{Kind: "log",
				Message: "warning: outbox persistence disabled — " + err.Error()}
		}()
		ob = &wsjtx.Outbox{}
	}
	s.outbox = ob

	ctx, cancel := context.WithCancel(context.Background())
	s.retryCancel = cancel
	go s.retryLoop(ctx)
	return s
}

// events returns the channel the UI reads listener events from.  Never
// closed for the lifetime of the process (start/stop are cheap; a closed
// channel would make the UI's select loop harder).
func (s *session) Events() <-chan listenerEvent { return s.events }

// emit pushes an event; drops if the channel buffer is full (64 slots
// should be plenty for one WSJT-X — QSOs come in at most a couple per
// second).
func (s *session) emit(e listenerEvent) {
	select {
	case s.events <- e:
	default:
	}
}

// emitQueueChanged tells the UI to refresh its "N pending" label.  Cheap
// to call — the UI only rebuilds the label when the number differs from
// what it last showed.
func (s *session) emitQueueChanged() {
	s.emit(listenerEvent{Kind: "queue", Pending: s.outbox.Len()})
}

// OutboxLen exposes the current pending count for the UI to poll on
// startup (before the first queue event fires).
func (s *session) OutboxLen() int { return s.outbox.Len() }

// normaliseBase strips a trailing "/" and applies the "bare host:port →
// https://" default that the CLI bridge and the Qt bridge both use.
func normaliseBase(s string) string {
	s = strings.TrimSpace(s)
	for strings.HasSuffix(s, "/") {
		s = strings.TrimSuffix(s, "/")
	}
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		s = "https://" + s
	}
	return s
}

// Reset drops the CSRF token and cookies so the operator can switch modes
// or accounts without restarting the process.  Does NOT stop a running
// listener (call Stop first) and does NOT clear the outbox — items keep
// their embedded endpoint so a cookie-mode item will still POST to
// /api/qsos even after the session flips to token mode.
func (s *session) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.csrfToken = ""
	s.loggedIn = false
	s.helperToken = ""
	s.tokenContestID = 0
	s.tokenStationCall = ""
	jar, _ := cookiejar.New(nil)
	s.hc = &http.Client{Jar: jar, Timeout: 15 * time.Second}
}

// ── Password auth ────────────────────────────────────────────────────────

// Login authenticates the operator via POST /api/login.  On success the
// CSRF token is stashed in the session so subsequent mutating calls (POST
// /api/qsos, POST /api/contests/*/select) carry X-CSRF-Token.
func (s *session) Login(server, user, pass string) error {
	base := normaliseBase(server)
	if base == "" {
		return errors.New("Server URL is required")
	}
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := s.hc.Post(base+"/api/login", "application/json", bytes.NewReader(body))
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
		return errors.New("no csrf_token in response")
	}
	s.mu.Lock()
	s.serverBase = base
	s.csrfToken = out.CSRFToken
	s.loggedIn = true
	s.helperToken = "" // switching modes → clear the other side's state
	s.mu.Unlock()
	// Wake the retry loop in case the queue was waiting for a session.
	s.pokeRetry()
	return nil
}

// FetchContests lists contests the current session can see.  Requires a
// prior successful Login.
func (s *session) FetchContests() ([]contest, error) {
	s.mu.Lock()
	base := s.serverBase
	s.mu.Unlock()
	resp, err := s.hc.Get(base + "/api/contests")
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

// SelectContest binds a contest to the current cookie session so
// subsequent POST /api/qsos calls know where to log.
func (s *session) SelectContest(id int64) error {
	s.mu.Lock()
	base := s.serverBase
	csrf := s.csrfToken
	s.mu.Unlock()
	u := fmt.Sprintf("%s/api/contests/%d/select", base, id)
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader([]byte("{}")))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	resp, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpError(resp)
	}
	return nil
}

// ── Token auth ───────────────────────────────────────────────────────────

// ConfigureToken decodes the copy-pasteable "noc1.…" blob and configures
// the session for header-based auth.  From here QSOs go to
// /api/wsjtx/qsos with an X-Helper-Token header and contest_id in the
// body instead of the cookie-authenticated /api/qsos.
func (s *session) ConfigureToken(blob string) error {
	tk, err := wsjtx.DecodeBridgeToken(blob)
	if err != nil {
		return errors.New("bridge token is not valid — paste the whole \"noc1.…\" string from the Noctalum web UI")
	}
	s.mu.Lock()
	s.serverBase = normaliseBase(tk.Server)
	s.helperToken = tk.HelperToken
	s.tokenContestID = tk.ContestID
	s.tokenStationCall = tk.StationCall
	s.csrfToken = ""
	s.loggedIn = false
	s.mu.Unlock()
	// Fresh token might unlock a queue that was stalled on missing auth.
	s.pokeRetry()
	return nil
}

// TokenContestInfo exposes the fields the UI needs to display which
// contest the operator is about to log into.  Returns zero values when the
// session is not in token mode.
func (s *session) TokenContestInfo() (int64, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokenContestID, s.tokenStationCall
}

// ── UDP listener ─────────────────────────────────────────────────────────

// StartListening binds the UDP port and spawns a goroutine that forwards
// every LOG_QSO datagram it decodes into the outbox — from where the
// retry loop pushes it to the server.  Returns immediately after the
// socket is bound.  Progress and QSOs are reported through Events().
func (s *session) StartListening(udpAddr string, forceDup bool) error {
	s.mu.Lock()
	if s.pc != nil {
		s.mu.Unlock()
		return errors.New("already listening — stop first")
	}
	pc, err := listenUDP(udpAddr)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("bind %s: %w", udpAddr, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.pc = pc
	s.cancel = cancel
	s.mu.Unlock()

	s.emit(listenerEvent{Kind: "listening", Message: udpAddr})
	// New "listening" session: flush anything the outbox has queued
	// from a previous run so the operator sees progress right away.
	s.pokeRetry()

	go s.listenLoop(ctx, pc, forceDup)
	return nil
}

// Stop closes the UDP socket and waits for the listener goroutine to
// notice via its context cancellation.  Idempotent: calling on a stopped
// session is a no-op.  Does NOT stop the retry loop — pending QSOs keep
// draining even after the operator hits Stop, so nothing sits stalled.
func (s *session) Stop() {
	s.mu.Lock()
	pc := s.pc
	cancel := s.cancel
	s.pc = nil
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if pc != nil {
		_ = pc.Close()
	}
}

// Listening reports whether StartListening is currently active.
func (s *session) Listening() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pc != nil
}

func (s *session) listenLoop(ctx context.Context, pc net.PacketConn, forceDup bool) {
	buf := make([]byte, 65535)
	for {
		select {
		case <-ctx.Done():
			s.emit(listenerEvent{Kind: "stopped"})
			return
		default:
		}
		// Short read deadline so ctx.Done() is checked frequently — a
		// blocked ReadFrom would ignore Stop() until the next datagram.
		_ = pc.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			s.emit(listenerEvent{Kind: "stopped"})
			return
		}
		q, err := wsjtx.ParseLogQSO(buf[:n])
		if err != nil {
			continue // not LOG_QSO — WSJT-X sends heartbeats/status too
		}
		s.enqueue(q, forceDup)
	}
}

// enqueue handles one just-decoded WSJT-X QSO: runs the client-side
// callsign filter, then persists it to the outbox and pokes the retry
// loop so the first send attempt happens right away.  Nothing sends
// synchronously here — that keeps this fast (the UDP listener is
// single-threaded) and gives the retry loop full ownership of the
// outbox for both first sends and retries.
func (s *session) enqueue(q *wsjtx.LogQSO, forceDup bool) {
	s.mu.Lock()
	tokenMode := s.helperToken != ""
	tokenContest := s.tokenContestID
	stationCall := s.tokenStationCall
	s.mu.Unlock()

	// Client-side callsign filter (token mode only, and only when the
	// token carries a station_call — pre-v0.76 tokens don't).
	if tokenMode && stationCall != "" && q.MyCall != "" {
		if wsjtx.BaseCallsign(q.MyCall) != wsjtx.BaseCallsign(stationCall) {
			skipped := &wsjtx.OutboxItem{
				Callsign: q.DxCall,
				Mode:     q.Mode,
				MyCall:   q.MyCall,
			}
			s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{
				Item: skipped, Kind: qsoSkipped,
				Err: fmt.Sprintf("skipped — WSJT-X station callsign %s doesn't match the contest station %s",
					q.MyCall, stationCall),
			}})
			return
		}
	}

	payload := map[string]any{
		"callsign":     strings.ToUpper(strings.TrimSpace(q.DxCall)),
		"freq_hz":      int64(q.DialFrequency),
		"mode":         q.Mode,
		"rst_sent":     strings.TrimSpace(q.ReportSent),
		"rst_received": strings.TrimSpace(q.ReportReceived),
		"locator":      strings.ToUpper(strings.TrimSpace(q.DxGrid)),
		"time":         q.Time().Format(time.RFC3339),
	}
	if notes := q.Notes(); notes != "" {
		payload["notes"] = notes
	}

	endpoint := "/api/qsos"
	if tokenMode {
		endpoint = "/api/wsjtx/qsos"
		payload["contest_id"] = tokenContest
		if q.MyCall != "" {
			payload["my_call"] = q.MyCall
		}
	}
	body, _ := json.Marshal(payload)
	item := &wsjtx.OutboxItem{
		Endpoint:  endpoint,
		Body:      body,
		ContestID: tokenContest,
		Callsign:  q.DxCall,
		Mode:      q.Mode,
		MyCall:    q.MyCall,
		ForceDup:  forceDup,
	}
	if err := s.outbox.Add(item); err != nil {
		s.emit(listenerEvent{Kind: "log",
			Message: "warning: outbox persistence failed (" + err.Error() + ") — sending in-memory only"})
	}
	s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{Item: item, Kind: qsoQueued}})
	s.emitQueueChanged()
	s.pokeRetry()
}

// ── Retry loop ───────────────────────────────────────────────────────────

const (
	baseRetryInterval = 5 * time.Second
	maxRetryInterval  = 5 * time.Minute
)

// pokeRetry wakes the retry loop immediately.  Used both for "we just
// got a new item, try to send now" and for "auth changed, previously
// stalled items may now succeed".
func (s *session) pokeRetry() {
	select {
	case s.pendingChanged <- struct{}{}:
	default:
	}
}

// retryLoop is the single point that talks to the server.  Everything
// else in this file writes to the outbox; retryLoop drains it.  Runs
// for the process lifetime with exponential backoff between failing
// waves so a long outage doesn't hammer the network.
func (s *session) retryLoop(ctx context.Context) {
	interval := baseRetryInterval
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.pendingChanged:
			// Fresh item or fresh auth — try again right away, and
			// reset the backoff because the trigger is probably a
			// meaningful state change.
			interval = baseRetryInterval
		case <-time.After(interval):
		}

		if s.outbox.Len() == 0 {
			interval = baseRetryInterval
			continue
		}
		succeeded, tried := s.flushOutbox()
		if tried == 0 {
			// Nothing was actually attempted (e.g. session not
			// configured yet) — don't grow the backoff.
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

// flushOutbox walks a snapshot of the queue, sending items one at a
// time.  Stops on the first retriable failure so we don't hammer a
// down server with the full queue every wave.  Returns (successes,
// attempts) so retryLoop can adjust its backoff.
func (s *session) flushOutbox() (succeeded, tried int) {
	snap := s.outbox.Snapshot()
	for i := range snap {
		it := snap[i]
		result, msg := s.trySendItem(&it)
		tried++
		switch result {
		case wsjtx.SendOK:
			_ = s.outbox.Remove(it.ID)
			s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{Item: &it, Kind: qsoSent}})
			s.emitQueueChanged()
			succeeded++
		case wsjtx.SendDrop:
			_ = s.outbox.Remove(it.ID)
			s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{Item: &it, Kind: qsoDropped, Err: msg}})
			s.emitQueueChanged()
			// A drop isn't a network failure — don't grow the
			// backoff.  Count it toward `succeeded` so retryLoop
			// treats the wave as healthy.
			succeeded++
		case wsjtx.SendRetry:
			_ = s.outbox.UpdateError(it.ID, msg)
			s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{Item: &it, Kind: qsoRetry, Err: msg}})
			// Stop draining after the first retriable failure —
			// the rest of the queue would just repeat the same
			// error.  We'll come back on the next retry tick.
			return
		}
	}
	return
}

// trySendItem POSTs one item and classifies the outcome.  Auth is
// attached from the current session state, not from anything persisted
// on the item, so re-auth (fresh login, pasting a new token) picks up
// the queue transparently.
func (s *session) trySendItem(item *wsjtx.OutboxItem) (wsjtx.SendResult, string) {
	s.mu.Lock()
	base := s.serverBase
	csrf := s.csrfToken
	helperTok := s.helperToken
	s.mu.Unlock()

	if base == "" {
		return wsjtx.SendRetry, "session not configured"
	}
	url := base + item.Endpoint
	if item.ForceDup {
		url += "?force=1"
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(item.Body))
	if err != nil {
		// Malformed URL etc — nothing a retry will fix.
		return wsjtx.SendDrop, err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.HasSuffix(item.Endpoint, "/wsjtx/qsos") {
		if helperTok == "" {
			return wsjtx.SendRetry, "no helper token configured"
		}
		req.Header.Set("X-Helper-Token", helperTok)
	} else {
		if csrf == "" {
			return wsjtx.SendRetry, "not logged in"
		}
		req.Header.Set("X-CSRF-Token", csrf)
	}

	resp, err := s.hc.Do(req)
	if err != nil {
		// Transport error: DNS, connect refused, TLS, timeout — retry.
		return wsjtx.SendRetry, err.Error()
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated:
		return wsjtx.SendOK, ""
	case http.StatusConflict:
		// Duplicate that ForceDup wouldn't have overridden.  Drop
		// with a clear message — the operator can enable "Log
		// duplicates" if they really want it in.
		return wsjtx.SendDrop, "duplicate (enable \"Log duplicates\" to override)"
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		// The server rejected the QSO data itself (bad callsign,
		// callsign-mismatch, invalid mode).  Retrying won't fix that,
		// but the operator should see the error so they can fix
		// WSJT-X and re-log.
		return wsjtx.SendDrop, httpErrorMessage(resp)
	default:
		// 401/403 (auth), 5xx (server transient), anything else — treat
		// as retriable so a re-login or a bounced server recovers
		// automatically.  A truly broken auth will surface as repeated
		// warnings in the Activity log; the operator hits Stop, fixes
		// their credentials, and the queue drains.
		return wsjtx.SendRetry, httpErrorMessage(resp)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

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

// listenUDP opens a UDP listener; automatically joins the multicast group
// when the address is a multicast IP (e.g. 224.0.0.1:2237, the WSJT-X
// default for its status port).
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
