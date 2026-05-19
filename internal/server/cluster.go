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

	"github.com/noctalum/noctalum/internal/store"
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
	freqMode := modeFromFreqKHz(freq)
	if mode == "" {
		mode = freqMode
	} else if (mode == "SSB" || mode == "AM") && (freqMode == "CW" || freqMode == "DIGI") {
		// Comment says phone mode but frequency is in a CW/DIGI zone — trust the band plan.
		mode = freqMode
	}

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

// modeFromFreqKHz infers the most likely mode from a frequency string (kHz)
// using IARU Region 1 band plans and WSJT-X default calling frequencies.
func modeFromFreqKHz(s string) string {
	var f float64
	if _, err := fmt.Sscanf(s, "%f", &f); err != nil {
		return ""
	}

	// Well-known FT8 calling frequencies (WSJT-X defaults, ±2 kHz tolerance).
	for _, ff := range []float64{
		1840,   // 160 m
		3573,   // 80 m
		5357,   // 60 m
		7074,   // 40 m
		10136,  // 30 m
		14074,  // 20 m
		18100,  // 17 m
		21074,  // 15 m
		24915,  // 12 m
		28074,  // 10 m
		50313,  // 6 m
		70154,  // 4 m
		144174, // 2 m
		432174, // 70 cm
	} {
		if f >= ff-2 && f <= ff+2 {
			return "FT8"
		}
	}
	// Well-known FT4 calling frequencies (±2 kHz tolerance).
	for _, ff := range []float64{
		3575,   // 80 m
		7047.5, // 40 m
		10140,  // 30 m
		14080,  // 20 m
		18104,  // 17 m
		21091,  // 15 m
		24919,  // 12 m
		28091,  // 10 m
		50323,  // 6 m
	} {
		if f >= ff-2 && f <= ff+2 {
			return "FT4"
		}
	}

	// Band-segment fallback (IARU Region 1 band plan, 2016 edition).
	switch {
	// 160 m: CW 1800-1838, DIGI 1838-1843, SSB 1843-2000
	case f >= 1800 && f < 1838:
		return "CW"
	case f >= 1838 && f < 1843:
		return "DIGI"
	case f >= 1843 && f < 2000:
		return "SSB"

	// 80 m: CW 3500-3570, DIGI 3570-3600 (FT8@3573, FT4@3575), SSB 3600+
	case f >= 3500 && f < 3570:
		return "CW"
	case f >= 3570 && f < 3600:
		return "DIGI"
	case f >= 3600 && f < 4000:
		return "SSB"

	// 60 m: WRC-15 secondary allocation, mixed
	case f >= 5351 && f <= 5367:
		return "SSB"

	// 40 m: CW 7000-7040, DIGI 7040-7100 (FT8@7074 lives here), SSB 7100+
	case f >= 7000 && f < 7040:
		return "CW"
	case f >= 7040 && f < 7100:
		return "DIGI"
	case f >= 7100 && f < 7300:
		return "SSB"

	// 30 m: CW 10100-10130, DIGI 10130-10150 (FT8@10136, FT4@10140); no phone
	case f >= 10100 && f < 10130:
		return "CW"
	case f >= 10130 && f <= 10150:
		return "DIGI"

	// 20 m: CW 14000-14070, DIGI 14070-14101 (FT8@14074, FT4@14080), SSB 14101+
	case f >= 14000 && f < 14070:
		return "CW"
	case f >= 14070 && f < 14101:
		return "DIGI"
	case f >= 14101 && f < 14350:
		return "SSB"

	// 17 m: CW 18068-18095, DIGI 18095-18110 (FT8@18100, FT4@18104), SSB 18110+
	case f >= 18068 && f < 18095:
		return "CW"
	case f >= 18095 && f < 18110:
		return "DIGI"
	case f >= 18110 && f <= 18168:
		return "SSB"

	// 15 m: CW 21000-21070, DIGI 21070-21110 (FT8@21074, FT4@21091), SSB 21110+
	case f >= 21000 && f < 21070:
		return "CW"
	case f >= 21070 && f < 21110:
		return "DIGI"
	case f >= 21110 && f < 21450:
		return "SSB"

	// 12 m: CW 24890-24920, DIGI 24920-24930 (FT8@24915, FT4@24919), SSB 24930+
	case f >= 24890 && f < 24920:
		return "CW"
	case f >= 24920 && f < 24930:
		return "DIGI"
	case f >= 24930 && f <= 24990:
		return "SSB"

	// 10 m: CW 28000-28070, DIGI 28070-28190 (FT8@28074, FT4@28091), SSB 28190-29000, FM 29000+
	case f >= 28000 && f < 28070:
		return "CW"
	case f >= 28070 && f < 28190:
		return "DIGI"
	case f >= 28190 && f < 29000:
		return "SSB"
	case f >= 29000 && f < 29700:
		return "FM"

	// 6 m: CW 50000-50100, DIGI 50100-50500 (FT8@50313, FT4@50323), SSB 50500-52000, FM 52000+
	case f >= 50000 && f < 50100:
		return "CW"
	case f >= 50100 && f < 50500:
		return "DIGI"
	case f >= 50500 && f < 52000:
		return "SSB"
	case f >= 52000 && f < 54000:
		return "FM"

	// 4 m: CW 70000-70100, DIGI 70100-70200 (FT8@70154), SSB 70200-70500, FM 70500+
	case f >= 70000 && f < 70100:
		return "CW"
	case f >= 70100 && f < 70200:
		return "DIGI"
	case f >= 70200 && f < 70500:
		return "SSB"
	case f >= 70500 && f < 74000:
		return "FM"

	// 2 m: CW 144000-144150, DIGI 144150-144400 (FT8@144174), SSB 144400-145000, FM 145000+
	case f >= 144000 && f < 144150:
		return "CW"
	case f >= 144150 && f < 144400:
		return "DIGI"
	case f >= 144400 && f < 145000:
		return "SSB"
	case f >= 145000 && f < 148000:
		return "FM"

	// 70 cm: CW 430000-432100, DIGI 432100-432500 (FT8@432174), SSB 432500-433000, FM 433000+
	case f >= 430000 && f < 432100:
		return "CW"
	case f >= 432100 && f < 432500:
		return "DIGI"
	case f >= 432500 && f < 433000:
		return "SSB"
	case f >= 433000 && f < 440000:
		return "FM"
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
