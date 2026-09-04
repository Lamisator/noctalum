package server

import (
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

// TestConcurrentRigsAndOperators_NoDeadlock stresses the two call paths
// that closed an AB-BA lock cycle in production on 2026-08-15:
//
//   - RigRegistry.AllForContest(rigUsage) held rigs.mu while invoking a
//     callback that acquired hub.mu.
//   - Hub.OperatorsForContest(cid, rigBand) held hub.mu while invoking a
//     callback that acquired rigs.mu.
//
// On the pre-fix code, running these two paths concurrently reliably
// deadlocked within a few iterations. The fix in hub.go / rig.go
// snapshots state under each lock and only invokes the caller-supplied
// callback after releasing it. This test is the guard-rail: any future
// change that re-introduces a callback under one of these mutexes will
// hang and be caught by the deadline below, not by the next operator
// who happens to click a contest.
//
// Run under `go test -race` in CI; the deadline covers both the race
// detector's overhead and the extra work we do on slow build hosts.
func TestConcurrentRigsAndOperators_NoDeadlock(t *testing.T) {
	t.Parallel()

	hub := NewHub(nil, nil, nil)
	rigs := NewRigRegistry()

	const (
		numRigs    = 5
		numClients = 32
		numWorkers = 8
		iterPer    = 500
		deadline   = 10 * time.Second
	)

	for i := 0; i < numRigs; i++ {
		rigs.AddDummy(fmt.Sprintf("rig-%d", i), int64(14000000+i*10000))
	}

	// Wire enough browser clients that the map iterations in
	// OperatorsForContest / RigUsageForContest have realistic
	// per-iteration work; deadlocks manifest even with one client, but
	// a fuller map makes non-deadlock latency variance visible on CI.
	for i := 0; i < numClients; i++ {
		sess := &Session{
			ID:       fmt.Sprintf("sess-%d", i),
			UserID:   int64(i + 1),
			Username: fmt.Sprintf("op%d", i),
			Callsign: fmt.Sprintf("CALL%d", i),
		}
		sess.SetSelectedRig(fmt.Sprintf("rig-%d", i%numRigs))
		sess.SetContest(1, "open", "STATION", "Test Contest", "",
			"", "", "", false, "open", 0, "", "", "", true, "kHz")
		c := &client{
			hub:     hub,
			role:    RoleBrowser,
			session: sess,
			// Buffered so a stray deliver during the test cannot
			// block; nothing in this test actually broadcasts, but
			// keeping the channel healthy avoids surprises if
			// hub.remove is ever wired in.
			send: make(chan []byte, 8),
		}
		hub.add(c)
	}

	rigBand := func(name string) string {
		r, _ := rigs.Get(name)
		return r.Band
	}
	rigUsage := func(name string) ([]string, []string) {
		return hub.RigUsageForContest(name, 1)
	}

	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for w := 0; w < numWorkers; w++ {
			wg.Add(2)
			go func() {
				defer wg.Done()
				for i := 0; i < iterPer; i++ {
					_ = rigs.AllForContest(rigUsage)
				}
			}()
			go func() {
				defer wg.Done()
				for i := 0; i < iterPer; i++ {
					_ = hub.OperatorsForContest(1, rigBand)
				}
			}()
		}
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(deadline):
		// Dump every goroutine so failure output points straight at the
		// stuck stacks (this is what SIGQUIT gave us during the live
		// incident; embedding it in the test makes root-causing a CI
		// regression a one-step process).
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		t.Fatalf("rigs.AllForContest and hub.OperatorsForContest deadlocked "+
			"after %s (this is the 2026-08-15 AB-BA regression); "+
			"goroutines:\n%s", deadline, buf[:n])
	}
}
