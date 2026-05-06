package server

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/contestlog/contestlog/internal/store"
)

const (
	clusterDefaultServer = "dxc.ve7cc.net:23"
	clusterMaxSpots      = 300
	clusterMaxLog        = 200
)

var clusterState struct {
	mu        sync.Mutex
	spots     []store.ClusterSpot
	log       []string // raw telnet lines, newest first
	connected bool
	myCall    string
	server    string
	reconnect chan struct{} // closed to trigger reconnect
	st        *store.Store
}

func init() {
	clusterState.reconnect = make(chan struct{})
}

// InitCluster wires the store into the cluster subsystem and loads persisted spots.
func InitCluster(st *store.Store, retentionDays int) {
	clusterState.mu.Lock()
	clusterState.st = st
	clusterState.mu.Unlock()

	if spots, err := st.LoadRecentClusterSpots(clusterMaxSpots); err == nil && len(spots) > 0 {
		clusterState.mu.Lock()
		clusterState.spots = spots
		clusterState.mu.Unlock()
		log.Printf("cluster: loaded %d spots from database", len(spots))
	}

	if retentionDays > 0 {
		if err := st.PruneClusterSpots(retentionDays); err != nil {
			log.Printf("cluster: prune error: %v", err)
		}
	}
}

// SetClusterCall updates the callsign used to log in to the DX cluster.
// If the call changed, the current connection is dropped so it reconnects.
func SetClusterCall(call string) {
	clusterState.mu.Lock()
	changed := call != clusterState.myCall
	clusterState.myCall = call
	ch := clusterState.reconnect
	clusterState.mu.Unlock()
	if changed {
		clusterState.mu.Lock()
		clusterState.reconnect = make(chan struct{})
		clusterState.mu.Unlock()
		close(ch)
	}
}

func getClusterCall() string {
	clusterState.mu.Lock()
	defer clusterState.mu.Unlock()
	if clusterState.myCall == "" {
		return "N0CALL"
	}
	return clusterState.myCall
}

// SetClusterServer updates the telnet server address (host:port).
// An empty string resets to the default. If the address changed, the current
// connection is dropped so the client reconnects to the new server.
func SetClusterServer(server string) {
	if server == "" {
		server = clusterDefaultServer
	}
	clusterState.mu.Lock()
	changed := server != clusterState.server
	clusterState.server = server
	ch := clusterState.reconnect
	clusterState.mu.Unlock()
	if changed {
		clusterState.mu.Lock()
		clusterState.reconnect = make(chan struct{})
		clusterState.mu.Unlock()
		close(ch)
	}
}

func getClusterServer() string {
	clusterState.mu.Lock()
	defer clusterState.mu.Unlock()
	if clusterState.server == "" {
		return clusterDefaultServer
	}
	return clusterState.server
}

func getReconnectCh() chan struct{} {
	clusterState.mu.Lock()
	defer clusterState.mu.Unlock()
	return clusterState.reconnect
}

// dxSpotRe matches lines like:
// DX de OH2BH:     14195.0  DX0DX        CQ                           1234Z
var dxSpotRe = regexp.MustCompile(
	`^DX de\s+(\S+):\s+(\d+\.?\d*)\s+(\S+)\s+(.*?)\s*(\d{4}Z)?\s*$`,
)

func startClusterClient(ctx context.Context) {
	go func() {
		for {
			if ctx.Err() != nil {
				return
			}
			reconnectCh := getReconnectCh()
			connectAndRead(ctx, reconnectCh)
			select {
			case <-ctx.Done():
				return
			case <-reconnectCh:
				// callsign changed — reconnect immediately
			case <-time.After(30 * time.Second):
			}
		}
	}()
}

func connectAndRead(ctx context.Context, reconnectCh chan struct{}) {
	myCall := getClusterCall()
	server := getClusterServer()
	log.Printf("cluster: connecting to %s as %s", server, myCall)
	appendClusterLog(fmt.Sprintf(">>> Connecting to %s as %s", server, myCall))

	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", server)
	if err != nil {
		msg := fmt.Sprintf(">>> Dial error: %v", err)
		log.Printf("cluster: %s", msg)
		appendClusterLog(msg)
		return
	}
	defer conn.Close()

	clusterState.mu.Lock()
	clusterState.connected = true
	clusterState.mu.Unlock()
	defer func() {
		clusterState.mu.Lock()
		clusterState.connected = false
		clusterState.mu.Unlock()
	}()

	time.Sleep(2 * time.Second)
	fmt.Fprintf(conn, "%s\r\n", myCall)
	appendClusterLog(fmt.Sprintf(">>> Sent callsign: %s", myCall))

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
		case <-reconnectCh:
		case <-done:
			return
		}
		conn.Close()
	}()
	defer close(done)

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		appendClusterLog(line)
		if spot, ok := parseDXSpot(line); ok {
			addSpot(spot)
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		appendClusterLog(fmt.Sprintf(">>> Read error: %v", err))
		log.Printf("cluster: read error: %v", err)
	} else {
		appendClusterLog(">>> Disconnected")
		log.Printf("cluster: disconnected")
	}
}

func appendClusterLog(line string) {
	clusterState.mu.Lock()
	defer clusterState.mu.Unlock()
	logs := make([]string, 0, clusterMaxLog)
	logs = append(logs, line)
	for _, l := range clusterState.log {
		if len(logs) >= clusterMaxLog {
			break
		}
		logs = append(logs, l)
	}
	clusterState.log = logs
}

func parseDXSpot(line string) (store.ClusterSpot, bool) {
	m := dxSpotRe.FindStringSubmatch(line)
	if m == nil {
		return store.ClusterSpot{}, false
	}
	spotter := strings.TrimSuffix(m[1], ":")
	freq := m[2]
	dx := m[3]
	comment := strings.TrimSpace(m[4])
	timeStr := m[5]
	if timeStr == "" {
		timeStr = time.Now().UTC().Format("1504Z")
	}

	band := freqKHzToBand(freq)
	mode := modeFromComment(comment)

	return store.ClusterSpot{
		Time:    timeStr,
		DX:      dx,
		Freq:    freq,
		Band:    band,
		Mode:    mode,
		Comment: comment,
		Spotter: spotter,
	}, true
}

func modeFromComment(comment string) string {
	upper := strings.ToUpper(comment)
	for _, m := range []string{"FT8", "FT4", "RTTY", "PSK31", "PSK63", "JT65", "CW", "SSB", "FM", "AM", "DIGI"} {
		if strings.Contains(upper, m) {
			return m
		}
	}
	return ""
}

func addSpot(spot store.ClusterSpot) {
	clusterState.mu.Lock()
	st := clusterState.st
	spots := make([]store.ClusterSpot, 0, clusterMaxSpots)
	spots = append(spots, spot)
	for _, s := range clusterState.spots {
		if len(spots) >= clusterMaxSpots {
			break
		}
		spots = append(spots, s)
	}
	clusterState.spots = spots
	clusterState.mu.Unlock()

	if st != nil {
		if err := st.SaveClusterSpot(spot); err != nil {
			log.Printf("cluster: save spot: %v", err)
		}
	}
}

func (s *Server) handleClusterSpots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	clusterState.mu.Lock()
	spots := make([]store.ClusterSpot, len(clusterState.spots))
	copy(spots, clusterState.spots)
	connected := clusterState.connected
	clusterState.mu.Unlock()

	if spots == nil {
		spots = []store.ClusterSpot{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"connected": connected,
		"spots":     spots,
	})
}

func (s *Server) handleClusterLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	clusterState.mu.Lock()
	logs := make([]string, len(clusterState.log))
	copy(logs, clusterState.log)
	connected := clusterState.connected
	myCall := clusterState.myCall
	clusterState.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"connected": connected,
		"call":      myCall,
		"server":    getClusterServer(),
		"lines":     logs,
	})
}

// freqKHzToBand maps a frequency string (kHz) to an amateur band name.
func freqKHzToBand(s string) string {
	var f float64
	if _, err := fmt.Sscanf(s, "%f", &f); err != nil {
		return ""
	}
	switch {
	case f < 2000:
		return "160m"
	case f < 4000:
		return "80m"
	case f < 5500:
		return "60m"
	case f < 8000:
		return "40m"
	case f < 11000:
		return "30m"
	case f < 15000:
		return "20m"
	case f < 19000:
		return "17m"
	case f < 22000:
		return "15m"
	case f < 25000:
		return "12m"
	case f < 30000:
		return "10m"
	case f < 54000:
		return "6m"
	case f < 75000:
		return "4m"
	case f < 148000:
		return "2m"
	case f < 450000:
		return "70cm"
	case f < 1300000:
		return "23cm"
	case f < 2500000:
		return "13cm"
	default:
		return "3cm"
	}
}
