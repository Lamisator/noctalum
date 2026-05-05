// contestlog-helper bridges a local Hamlib rigctld instance to a remote
// ContestLog server.  Run one instance on each operator's computer; the helper
// reads frequency and mode from the local transceiver and pushes them to the
// server, where it is registered as a named rig that any operator can choose
// to bind to for auto-fill.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	server := flag.String("server", "http://localhost:8080", "ContestLog server URL")
	name := flag.String("name", "", "rig display name (e.g. \"IC-7300\") — required")
	token := flag.String("token", "", "helper token from the server's Settings — required")
	rigHost := flag.String("rig-host", "127.0.0.1", "rigctld host")
	rigPort := flag.Int("rig-port", 4532, "rigctld TCP port")
	intervalMs := flag.Int("interval", 1000, "polling interval in milliseconds")
	flag.Parse()

	if *name == "" {
		log.Fatal("-name is required")
	}
	if *token == "" {
		log.Fatal("-token is required (see ContestLog Settings)")
	}
	if *intervalMs < 250 {
		*intervalMs = 250
	}

	for {
		err := session(*server, *name, *token, *rigHost, *rigPort, *intervalMs)
		log.Printf("session ended: %v; reconnecting in 5s", err)
		time.Sleep(5 * time.Second)
	}
}

func session(serverURL, name, token, rigHost string, rigPort, intervalMs int) error {
	u, err := url.Parse(serverURL)
	if err != nil {
		return fmt.Errorf("parse server url: %w", err)
	}
	wsScheme := "ws"
	if u.Scheme == "https" {
		wsScheme = "wss"
	}
	q := url.Values{}
	q.Set("role", "helper")
	q.Set("name", name)
	q.Set("token", token)
	wsURL := fmt.Sprintf("%s://%s/ws?%s", wsScheme, u.Host, q.Encode())

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("ws dial: %w (HTTP %d)", err, resp.StatusCode)
		}
		return fmt.Errorf("ws dial: %w", err)
	}
	defer conn.Close()
	log.Printf("registered rig %q at %s", name, serverURL)

	// Drain server-sent frames so the connection stays alive.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	push := func() error {
		freq, mode, rerr := readRig(rigHost, rigPort)
		out := map[string]any{"type": "rig_update"}
		if rerr != nil {
			out["error"] = rerr.Error()
		} else {
			out["freq_hz"] = freq
			out["mode"] = mode
		}
		data, _ := json.Marshal(out)
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteMessage(websocket.TextMessage, data)
	}

	if err := push(); err != nil {
		return err
	}
	tick := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer tick.Stop()
	for range tick.C {
		if err := push(); err != nil {
			return err
		}
	}
	return nil
}

// readRig opens a fresh rigctld connection and queries frequency + mode.
func readRig(host string, port int) (int64, string, error) {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 2*time.Second)
	if err != nil {
		return 0, "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))

	freqStr, err := query(c, "f")
	if err != nil {
		return 0, "", fmt.Errorf("get freq: %w", err)
	}
	freq, err := strconv.ParseInt(strings.TrimSpace(freqStr), 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("parse freq %q: %w", freqStr, err)
	}
	modeStr, _ := query(c, "m")
	mode := strings.TrimSpace(strings.SplitN(modeStr, "\n", 2)[0])
	return freq, mode, nil
}

func query(conn net.Conn, cmd string) (string, error) {
	if _, err := fmt.Fprintf(conn, "%s\n", cmd); err != nil {
		return "", err
	}
	br := bufio.NewReader(conn)
	var sb strings.Builder
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "RPRT ") {
			code := strings.TrimSpace(strings.TrimPrefix(line, "RPRT "))
			if code != "0" {
				return "", fmt.Errorf("rigctld error %s", code)
			}
			return strings.TrimRight(sb.String(), "\n"), nil
		}
		if sb.Len() > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(line)
		if sb.Len() > 1024 {
			return sb.String(), nil
		}
	}
}

