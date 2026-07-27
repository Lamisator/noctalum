// noctalum-wsjtx bridges WSJT-X to a remote Noctalum server.
// It logs in with username/password, lets the operator pick a contest, then
// listens on UDP for WSJT-X LOG_QSO messages and posts each one to the server.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strconv"
	"strings"
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

func main() {
	serverFlag := flag.String("server", "http://localhost:8080", "Noctalum server URL")
	userFlag := flag.String("user", "", "username — required")
	passFlag := flag.String("pass", "", "password (omit to be prompted)")
	udpFlag := flag.String("udp", "0.0.0.0:2237", "UDP address to listen for WSJT-X messages")
	forceDupFlag := flag.Bool("force-dup", false, "submit QSOs even if the server flags them as duplicates")
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
	hc := &http.Client{Jar: jar, Timeout: 15 * time.Second}

	csrfToken, err := doLogin(hc, server, *userFlag, pass)
	if err != nil {
		log.Fatalf("login failed: %v", err)
	}
	log.Printf("logged in as %s", *userFlag)

	contests, err := getContests(hc, server)
	if err != nil {
		log.Fatalf("list contests: %v", err)
	}
	if len(contests) == 0 {
		log.Fatal("no contests found on server — create one first via the web UI")
	}

	contestID := pickContest(contests)
	if err := doSelectContest(hc, server, csrfToken, contestID); err != nil {
		log.Fatalf("select contest: %v", err)
	}
	log.Printf("contest selected; listening for WSJT-X on %s", *udpFlag)

	pc, err := listenUDP(*udpFlag)
	if err != nil {
		log.Fatalf("udp listen: %v", err)
	}
	defer pc.Close()

	buf := make([]byte, 65535)
	for {
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			log.Printf("udp read: %v", err)
			continue
		}
		msg, err := wsjtx.ParseLogQSO(buf[:n])
		if err != nil {
			continue // not a LOG_QSO packet, silently ignore
		}
		if err := submitQSO(hc, server, csrfToken, msg, *forceDupFlag); err != nil {
			log.Printf("submit %s: %v", msg.DxCall, err)
		} else {
			log.Printf("logged: %-12s  %-8s  sent=%-4s  rcvd=%s",
				msg.DxCall, msg.Mode, msg.ReportSent, msg.ReportReceived)
		}
	}
}

// doLogin authenticates and returns the CSRF token from the session response.
func doLogin(c *http.Client, server, user, pass string) (string, error) {
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := c.Post(server+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, e.Error)
	}
	var out struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode login response: %w", err)
	}
	if out.CSRFToken == "" {
		return "", fmt.Errorf("no csrf_token in response")
	}
	return out.CSRFToken, nil
}

// getContests fetches the contest list from the server.
func getContests(c *http.Client, server string) ([]contest, error) {
	resp, err := c.Get(server + "/api/contests")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []contest
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

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

// doSelectContest selects a contest on the server for this session.
func doSelectContest(c *http.Client, server, csrf string, id int64) error {
	u := fmt.Sprintf("%s/api/contests/%d/select", server, id)
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader([]byte("{}")))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, e.Error)
	}
	return nil
}

// submitQSO posts a parsed WSJT-X QSO to the Noctalum server.
func submitQSO(c *http.Client, server, csrf string, m *wsjtx.LogQSO, forceDup bool) error {
	notes := m.Notes()

	payload := map[string]any{
		"callsign":     strings.ToUpper(strings.TrimSpace(m.DxCall)),
		"freq_hz":      int64(m.DialFrequency),
		"mode":         m.Mode,
		"rst_sent":     strings.TrimSpace(m.ReportSent),
		"rst_received": strings.TrimSpace(m.ReportReceived),
		"locator":      strings.ToUpper(strings.TrimSpace(m.DxGrid)),
		"time":         m.Time().Format(time.RFC3339),
	}
	if notes != "" {
		payload["notes"] = notes
	}

	body, _ := json.Marshal(payload)

	u := server + "/api/qsos"
	if forceDup {
		u += "?force=1"
	}
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)

	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated:
		return nil
	case http.StatusConflict:
		return fmt.Errorf("possible duplicate (use -force-dup to override)")
	default:
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&e)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, e.Error)
	}
}

// listenUDP opens a UDP listener; automatically joins multicast group if the
// address is a multicast IP (e.g. 224.0.0.1:2237, the WSJT-X default).
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
