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
	QSO     *wsjtx.LogQSO
	OK      bool
	Skipped bool   // true when the client-side callsign filter dropped it
	Err     string // set when OK==false
}

// listenerEvent groups the messages a running session emits back to the UI
// over a Go channel.  The channel is unbuffered but the UI reads it on a
// tight `select` loop wrapped in fyne's queue, so drops shouldn't happen
// in practice.
type listenerEvent struct {
	Kind    string // "log", "qso", "listening", "stopped", "error"
	Message string
	Result  *qsoResult
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
	helperToken       string
	tokenContestID    int64
	tokenStationCall  string // may be empty for pre-v0.76 tokens

	// Runtime
	events chan listenerEvent
	cancel context.CancelFunc
	pc     net.PacketConn
}

func newSession() *session {
	jar, _ := cookiejar.New(nil)
	return &session{
		hc:     &http.Client{Jar: jar, Timeout: 15 * time.Second},
		events: make(chan listenerEvent, 32),
	}
}

// events returns the channel the UI reads listener events from.  Never
// closed for the lifetime of the process (start/stop are cheap; a closed
// channel would make the UI's select loop harder).
func (s *session) Events() <-chan listenerEvent { return s.events }

// emit pushes an event; drops if the channel buffer is full (32 slots
// should be plenty for one WSJT-X — QSOs come in at most a couple per
// second).
func (s *session) emit(e listenerEvent) {
	select {
	case s.events <- e:
	default:
	}
}

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
// listener — call Stop() first if that's what you want.
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
// every LOG_QSO datagram it decodes to the server, honouring the
// client-side MyCall filter (in token mode) and forceDup on duplicates.
// Returns immediately after the socket is bound.  Progress and QSOs are
// reported through Events().
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

	go s.listenLoop(ctx, pc, forceDup)
	return nil
}

// Stop closes the UDP socket and waits for the listener goroutine to
// notice via its context cancellation.  Idempotent: calling on a stopped
// session is a no-op.
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
			// Real error — probably the socket got closed by Stop().
			// Bail out silently; the caller already knows.
			s.emit(listenerEvent{Kind: "stopped"})
			return
		}
		q, err := wsjtx.ParseLogQSO(buf[:n])
		if err != nil {
			continue // not LOG_QSO — WSJT-X sends heartbeats/status too
		}
		s.processQSO(q, forceDup)
	}
}

func (s *session) processQSO(q *wsjtx.LogQSO, forceDup bool) {
	s.mu.Lock()
	tokenMode := s.helperToken != ""
	stationCall := s.tokenStationCall
	s.mu.Unlock()

	// Client-side callsign filter (token mode only, and only when the
	// token carries a station_call — pre-v0.76 tokens don't).
	if tokenMode && stationCall != "" && q.MyCall != "" {
		if wsjtx.BaseCallsign(q.MyCall) != wsjtx.BaseCallsign(stationCall) {
			s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{
				QSO: q, Skipped: true,
				Err: fmt.Sprintf("skipped — WSJT-X station callsign %s doesn't match the contest station %s",
					q.MyCall, stationCall),
			}})
			return
		}
	}

	if err := s.submitQSO(q, forceDup); err != nil {
		s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{QSO: q, Err: err.Error()}})
		return
	}
	s.emit(listenerEvent{Kind: "qso", Result: &qsoResult{QSO: q, OK: true}})
}

func (s *session) submitQSO(q *wsjtx.LogQSO, forceDup bool) error {
	s.mu.Lock()
	base := s.serverBase
	csrf := s.csrfToken
	tokenMode := s.helperToken != ""
	helperTok := s.helperToken
	contestID := s.tokenContestID
	s.mu.Unlock()

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

	var url string
	if tokenMode {
		payload["contest_id"] = contestID
		if q.MyCall != "" {
			payload["my_call"] = q.MyCall
		}
		url = base + "/api/wsjtx/qsos"
	} else {
		url = base + "/api/qsos"
	}
	if forceDup {
		url += "?force=1"
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if tokenMode {
		req.Header.Set("X-Helper-Token", helperTok)
	} else if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}

	resp, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated:
		return nil
	case http.StatusConflict:
		return errors.New("possible duplicate — enable \"Log duplicates\" to override")
	default:
		return httpError(resp)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

func httpError(resp *http.Response) error {
	var e struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&e)
	if e.Error != "" {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, e.Error)
	}
	return fmt.Errorf("HTTP %d", resp.StatusCode)
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
