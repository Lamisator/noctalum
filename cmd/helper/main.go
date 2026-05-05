// contestlog-helper bridges a local Hamlib rigctld instance to a remote
// ContestLog server.  Run one instance per operator; the helper reads
// frequency and mode from the local transceiver and pushes them to the
// server, where the rig appears as a named entry that any operator can bind to.
//
// Running without arguments opens an interactive setup screen.
// With -rig-model the helper starts its own rigctld subprocess — no separate
// daemon needed.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const helperVersion = "0.1.0"

func main() {
	server := flag.String("server", "http://localhost:8080", "ContestLog server URL")
	name := flag.String("name", "", "rig display name (e.g. \"IC-7300\") — required")
	token := flag.String("token", "", "helper token from the server's Settings — required")
	rigHost := flag.String("rig-host", "127.0.0.1", "rigctld host")
	rigPort := flag.Int("rig-port", 4532, "rigctld TCP port")
	intervalMs := flag.Int("interval", 1000, "polling interval in milliseconds")

	// Managed rigctld mode: start rigctld automatically when -rig-model is set.
	rigModel := flag.Int("rig-model", 0, "Hamlib rig model number; if set, rigctld is started automatically")
	rigDevice := flag.String("rig-device", "", "serial device for the rig (e.g. /dev/ttyUSB0, COM3)")
	rigSpeed := flag.Int("rig-speed", 0, "serial baud rate (0 = rigctld default)")
	rigctldBin := flag.String("rigctld", "rigctld", "path to rigctld binary")
	flag.Parse()

	// No flags provided: launch the interactive setup TUI.
	if flag.NFlag() == 0 {
		cfg, err := runTUI()
		if err != nil {
			if errors.Is(err, errCancelled) {
				os.Exit(0)
			}
			log.Fatalf("TUI: %v", err)
		}
		*server = cfg.Server
		*name = cfg.Name
		*token = cfg.Token
		*rigModel = cfg.RigModel
		*rigDevice = cfg.RigDevice
		*rigSpeed = cfg.RigSpeed
		*rigctldBin = cfg.RigctldBin
		*intervalMs = cfg.IntervalMs
	}

	if *name == "" {
		log.Fatal("-name is required")
	}
	if *token == "" {
		log.Fatal("-token is required (see ContestLog Settings)")
	}
	if *intervalMs < 250 {
		*intervalMs = 250
	}

	logSettings(*server, *name, *rigModel, *rigDevice, *rigSpeed, *rigctldBin, *rigHost, *rigPort, *intervalMs)

	if *rigModel != 0 {
		port, err := freePort()
		if err != nil {
			log.Fatalf("find free port: %v", err)
		}
		*rigPort = port
		cmd, err := spawnRigctld(*rigctldBin, *rigModel, *rigDevice, *rigSpeed, *rigHost, port)
		if err != nil {
			log.Fatalf("start rigctld: %v", err)
		}
		defer func() { _ = cmd.Process.Kill() }()
		if err := waitForRigctld(*rigHost, port, 30*time.Second); err != nil {
			_ = cmd.Process.Kill()
			log.Fatalf("rigctld startup: %v", err)
		}
		log.Printf("rigctld started (model %d) on port %d", *rigModel, port)
	}

	for {
		err := session(*server, *name, *token, *rigHost, *rigPort, *intervalMs)
		log.Printf("session ended: %v; reconnecting in 5s", err)
		time.Sleep(5 * time.Second)
	}
}

func logSettings(server, name string, rigModel int, rigDevice string, rigSpeed int, rigctldBin, rigHost string, rigPort, intervalMs int) {
	log.Printf("=== ContestLog Helper v%s ===", helperVersion)
	log.Printf("  server:   %s", server)
	log.Printf("  rig name: %s", name)
	if rigModel != 0 {
		log.Printf("  rig mode: managed (spawning rigctld)")
		log.Printf("  rigctld:  %s", rigctldBin)
		log.Printf("  model:    %d", rigModel)
		if rigDevice != "" {
			log.Printf("  device:   %s", rigDevice)
		} else {
			log.Printf("  device:   (none specified — rigctld default)")
		}
		if rigSpeed != 0 {
			log.Printf("  speed:    %d baud", rigSpeed)
		} else {
			log.Printf("  speed:    (none specified — rigctld default)")
		}
	} else {
		log.Printf("  rig mode: external rigctld at %s:%d", rigHost, rigPort)
	}
	log.Printf("  interval: %d ms", intervalMs)
}

// freePort asks the OS for an available TCP port by binding to :0.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

// spawnRigctld starts a rigctld subprocess and returns the running Cmd.
func spawnRigctld(bin string, model int, device string, speed int, host string, port int) (*exec.Cmd, error) {
	args := []string{
		"-m", strconv.Itoa(model),
		"-T", host,
		"-t", strconv.Itoa(port),
	}
	if device != "" {
		args = append(args, "-r", device)
	}
	if speed != 0 {
		args = append(args, "-s", strconv.Itoa(speed))
	}
	log.Printf("  rigctld cmd: %s %s", bin, strings.Join(args, " "))
	cmd := exec.Command(bin, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec %q: %w", bin, err)
	}
	return cmd, nil
}

// waitForRigctld polls until rigctld's TCP port accepts connections.
// It only checks that rigctld is listening — rig availability is handled
// by the polling loop's back-off logic, which is better suited for it.
func waitForRigctld(host string, port int, timeout time.Duration) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err == nil {
			c.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("rigctld did not start after %v", timeout)
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

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Origin": []string{serverURL},
	})
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

	normalInterval := time.Duration(intervalMs) * time.Millisecond
	const maxBackoff = 30 * time.Second
	interval := normalInterval
	errCount := 0

	for {
		freq, mode, rigErr := readRig(rigHost, rigPort)

		if rigErr != nil {
			if errCount == 0 {
				log.Printf("rig %q offline: %v", name, rigErr)
			}
			errCount++
			interval = rigBackoff(normalInterval, maxBackoff, errCount)
		} else {
			if errCount > 0 {
				log.Printf("rig %q back online", name)
			}
			errCount = 0
			interval = normalInterval
		}

		out := map[string]any{"type": "rig_update"}
		if rigErr != nil {
			out["error"] = rigErr.Error()
		} else {
			out["freq_hz"] = freq
			out["mode"] = mode
		}
		data, _ := json.Marshal(out)
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return err
		}

		time.Sleep(interval)
	}
}

// rigBackoff doubles the base interval for each consecutive error, capped at max.
// errCount=1 → 2×base, errCount=2 → 4×base, etc.
func rigBackoff(base, max time.Duration, errCount int) time.Duration {
	d := base
	for i := 0; i < errCount; i++ {
		d *= 2
		if d >= max {
			return max
		}
	}
	return d
}

// readRig queries frequency and mode from rigctld, one connection per command.
// Each connection is half-closed after sending so rigctld flushes its response
// immediately — the same behaviour as `printf 'cmd\n' | nc host port`.
func readRig(host string, port int) (int64, string, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(5 * time.Second)

	freqStr, err := rigQuery(addr, "f", deadline)
	if err != nil {
		return 0, "", err
	}
	freq, err := strconv.ParseInt(strings.TrimSpace(freqStr), 10, 64)
	if err != nil {
		return 0, "", errors.New("rig returned invalid frequency")
	}
	modeStr, _ := rigQuery(addr, "m", deadline)
	mode := strings.TrimSpace(strings.SplitN(modeStr, "\n", 2)[0])
	return freq, mode, nil
}

// rigQuery opens a fresh connection, sends one command, half-closes the write
// side (CloseWrite), then reads the response.  Half-closing is the nc trick:
// rigctld only flushes the response once it sees the client is done writing.
func rigQuery(addr, cmd string, deadline time.Time) (string, error) {
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return "", errors.New("rigctld not responding")
		}
		return "", errors.New("cannot reach rigctld")
	}
	defer c.Close()
	_ = c.SetDeadline(deadline)

	if _, err := fmt.Fprintf(c, "%s\n", cmd); err != nil {
		return "", err
	}
	// Half-close write side — rigctld treats the FIN as end-of-request and
	// sends the response immediately, just like nc does when stdin closes.
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.CloseWrite()
	}

	br := bufio.NewReader(c)
	var sb strings.Builder
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(line, "RPRT ") {
				code := strings.TrimSpace(strings.TrimPrefix(line, "RPRT "))
				if code != "0" {
					return "", rprtError(code)
				}
				return strings.TrimRight(sb.String(), "\n"), nil
			}
			if sb.Len() > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(line)
		}
		if err != nil {
			// EOF means server closed — return whatever we accumulated.
			if err == io.EOF {
				return strings.TrimRight(sb.String(), "\n"), nil
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return "", errors.New("rig not responding")
			}
			return "", err
		}
	}
}

// rprtError translates a Hamlib RPRT error code to a human-readable error.
func rprtError(code string) error {
	switch code {
	case "-5":
		return errors.New("rig not responding")
	case "-9":
		return errors.New("rig timeout")
	default:
		return fmt.Errorf("rig error (RPRT %s)", code)
	}
}
