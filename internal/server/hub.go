package server

import (
	"encoding/json"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ClientRole distinguishes a browser session from a local helper.
type ClientRole int

const (
	RoleBrowser ClientRole = iota
	RoleHelper
)

// Event is a server-to-client websocket message.
type Event struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// inboundHandler is invoked for every JSON message a client sends.
type inboundHandler func(c *client, raw []byte)

// browserGoneHandler is invoked when a browser client disconnects so the
// server can recompute rig-in-use lists.
type browserGoneHandler func(operator, selectedRig string)

// helperGoneHandler is invoked when a helper disconnects so the server can
// update / remove that rig.
type helperGoneHandler func(rigName string)

// client is one open websocket connection.
type client struct {
	hub     *Hub
	conn    *websocket.Conn
	role    ClientRole
	session *Session // browser only
	rigName string   // helper only
	send    chan []byte
	once    sync.Once
}

// Operator returns the callsign for a browser client (helpers return "").
func (c *client) Operator() string {
	if c.role == RoleBrowser && c.session != nil {
		return c.session.Callsign
	}
	return ""
}

// Hub fans out events and tracks live connections.
type Hub struct {
	mu             sync.Mutex
	clients        map[*client]struct{}
	onInbound      inboundHandler
	onBrowserGone  browserGoneHandler
	onHelperGone   helperGoneHandler
}

// NewHub returns a ready hub.
func NewHub(inbound inboundHandler, browserGone browserGoneHandler, helperGone helperGoneHandler) *Hub {
	return &Hub{
		clients:       make(map[*client]struct{}),
		onInbound:     inbound,
		onBrowserGone: browserGone,
		onHelperGone:  helperGone,
	}
}

func (h *Hub) add(c *client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		c.once.Do(func() { close(c.send) })
	}
	h.mu.Unlock()
	if c.role == RoleBrowser && h.onBrowserGone != nil {
		h.onBrowserGone(c.Operator(), c.session.SelectedRig())
	}
	if c.role == RoleHelper && h.onHelperGone != nil {
		h.onHelperGone(c.rigName)
	}
}

// OperatorInfo holds the display name and callsign of a connected operator.
type OperatorInfo struct {
	Username string `json:"username"`
	Callsign string `json:"callsign"`
}

// Operators returns the de-duplicated, sorted list of currently logged-in
// browser operators.
func (h *Hub) Operators() []OperatorInfo {
	h.mu.Lock()
	seen := map[string]OperatorInfo{}
	for c := range h.clients {
		if c.role == RoleBrowser && c.session != nil && c.session.Callsign != "" {
			cs := c.session.Callsign
			if _, ok := seen[cs]; !ok {
				seen[cs] = OperatorInfo{Username: c.session.Username, Callsign: cs}
			}
		}
	}
	h.mu.Unlock()
	out := make([]OperatorInfo, 0, len(seen))
	for _, v := range seen {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Callsign < out[j].Callsign })
	return out
}

// BrowsersSelectingRig returns the unique sorted operator callsigns
// of browsers currently bound to the named rig.
func (h *Hub) BrowsersSelectingRig(name string) []string {
	if name == "" {
		return nil
	}
	h.mu.Lock()
	seen := map[string]struct{}{}
	for c := range h.clients {
		if c.role != RoleBrowser || c.session == nil {
			continue
		}
		if c.session.SelectedRig() == name {
			seen[c.session.Callsign] = struct{}{}
		}
	}
	h.mu.Unlock()
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ForEachBrowserOf calls fn for every browser of the given userID
// (used to re-push session state when a user is edited).
func (h *Hub) ForEachBrowserOf(userID int64, fn func(c *client)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.role == RoleBrowser && c.session != nil && c.session.UserID == userID {
			fn(c)
		}
	}
}

// SendToSession enqueues data for one specific session's browser clients.
func (h *Hub) SendToSession(sessionID string, ev Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.role == RoleBrowser && c.session != nil && c.session.ID == sessionID {
			h.deliver(c, data)
		}
	}
}

// Broadcast sends an event to every browser client.
func (h *Hub) Broadcast(ev Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.role != RoleBrowser {
			continue
		}
		h.deliver(c, data)
	}
}

// BroadcastToContest sends an event only to browser clients that have the
// given contest selected in their session.
func (h *Hub) BroadcastToContest(contestID int64, ev Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.role != RoleBrowser || c.session == nil {
			continue
		}
		id, _, _, _ := c.session.ContestInfo()
		if id != contestID {
			continue
		}
		h.deliver(c, data)
	}
}

// deliver attempts to enqueue data for c; on a full queue the connection is
// dropped.  Caller must hold h.mu.
func (h *Hub) deliver(c *client, data []byte) {
	select {
	case c.send <- data:
	default:
		c.once.Do(func() { close(c.send) })
		delete(h.clients, c)
	}
}

// SendToRig enqueues an event for all helper clients with the given rig name.
// Returns true if at least one helper received the message.
func (h *Hub) SendToRig(rigName string, ev Event) bool {
	data, err := json.Marshal(ev)
	if err != nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	sent := false
	for c := range h.clients {
		if c.role == RoleHelper && c.rigName == rigName {
			h.deliver(c, data)
			sent = true
		}
	}
	return sent
}

// readPump consumes incoming messages and dispatches them to the inbound handler.
func (c *client) readPump() {
	defer func() { c.hub.remove(c); _ = c.conn.Close() }()
	c.conn.SetReadLimit(8192)
	_ = c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	})
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if c.hub.onInbound != nil {
			c.hub.onInbound(c, msg)
		}
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() { ticker.Stop(); _ = c.conn.Close() }()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
