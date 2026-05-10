package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

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

type spawnArgs struct {
	Bin    string
	Model  int
	Device string
	Speed  int
	Host   string
	Port   int
}

// args returns the rigctld argv tail for display purposes (no binary path).
func (s spawnArgs) args() []string {
	args := []string{
		"-m", strconv.Itoa(s.Model),
		"-T", s.Host,
		"-t", strconv.Itoa(s.Port),
	}
	if s.Device != "" {
		args = append(args, "-r", s.Device)
	}
	if s.Speed != 0 {
		args = append(args, "-s", strconv.Itoa(s.Speed))
	}
	return args
}

func spawnRigctld(s spawnArgs) (*exec.Cmd, error) {
	cmd := exec.Command(s.Bin, s.args()...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec %q: %w", s.Bin, err)
	}
	return cmd, nil
}

// waitForRigctld polls until rigctld's TCP port accepts connections.
func waitForRigctld(host string, port int, timeout time.Duration) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
		if err == nil {
			c.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("rigctld did not start after %v", timeout)
}

// rigQuery opens a fresh connection, sends one command, half-closes the
// write side, then reads the response — same trick as `printf 'cmd\n' | nc`.
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

// readRig queries frequency and mode from rigctld, one connection per command.
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

func setRigFreq(host string, port int, freqHz int64) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(5 * time.Second)
	_, err := rigQuery(addr, fmt.Sprintf("F %d", freqHz), deadline)
	return err
}

func setRigMode(host string, port int, mode string) error {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	deadline := time.Now().Add(5 * time.Second)
	_, err := rigQuery(addr, fmt.Sprintf("M %s 0", mode), deadline)
	return err
}

// toRigctldMode translates a ContestLog mode string to the rigctld mode name.
func toRigctldMode(mode string, freqHz int64) string {
	switch strings.ToUpper(mode) {
	case "CW":
		return "CW"
	case "USB":
		return "USB"
	case "LSB":
		return "LSB"
	case "SSB":
		if freqHz > 0 && freqHz < 10_000_000 {
			return "LSB"
		}
		return "USB"
	case "FM":
		return "FM"
	case "AM":
		return "AM"
	case "RTTY":
		return "RTTY"
	case "FT8", "FT4", "PSK31", "PSK63", "JT65", "DIGI":
		return "USB"
	default:
		return ""
	}
}

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

// rigBackoff doubles the base interval for each consecutive error, capped at max.
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

// probeOnce spawns a temporary rigctld with the given arguments, waits for
// it to accept a TCP connection, issues a single "f" query, then kills the
// process.  Returns the read frequency on success.  This is the building
// block of the auto-detect phases.  rigctld output is muted because failed
// probes are normal here and would otherwise spam the parent's stderr.
func probeOnce(ctx context.Context, s spawnArgs) (int64, error) {
	cmd := exec.Command(s.Bin, s.args()...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	if err := waitForRigctld(s.Host, s.Port, 3*time.Second); err != nil {
		return 0, err
	}

	// Honour cancellation between rigctld start and the actual query.
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	default:
	}

	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	freqStr, err := rigQuery(addr, "f", time.Now().Add(2500*time.Millisecond))
	if err != nil {
		return 0, err
	}
	freq, err := strconv.ParseInt(strings.TrimSpace(freqStr), 10, 64)
	if err != nil {
		return 0, errors.New("rig returned invalid frequency")
	}
	if freq <= 0 {
		return 0, errors.New("rig returned non-positive frequency")
	}
	return freq, nil
}
