package server

import (
	"sort"
	"sync"
	"time"
)

// Rig is one transceiver as exposed by a connected helper or simulated as a dummy.
// Identified by Name (e.g. "IC-7300").  Two helpers presenting the same name
// are coalesced into one entry (last write wins for the freq/mode fields).
type Rig struct {
	Name          string    `json:"name"`
	Connected     bool      `json:"connected"`
	Error         string    `json:"error,omitempty"`
	FreqHz        int64     `json:"freq_hz"`
	Mode          string    `json:"mode"`
	Band          string    `json:"band"`
	HelperCount   int       `json:"helper_count"`
	Dummy         bool      `json:"dummy,omitempty"`
	InUseBy       []string  `json:"in_use_by"`                // operator callsigns (same contest) using this rig
	OtherContests []string  `json:"other_contests,omitempty"` // contest names of operators in other contests using this rig
	UpdatedAt     time.Time `json:"updated_at"`
}

// RigRegistry keeps an in-memory map of rigs.  Real rigs are added on the first
// helper update and removed when the last helper for that name disconnects.
// Dummy rigs are persistent simulated TRXs that react to set_freq commands.
// `InUseBy` is populated by the server using the hub's view of browser
// selections; the registry stores only what the helpers report.
type RigRegistry struct {
	mu      sync.Mutex
	rigs    map[string]*Rig
	helpers map[string]int  // name -> count of currently connected helpers
	dummies map[string]bool // names of dummy rigs
}

// NewRigRegistry returns an empty registry.
func NewRigRegistry() *RigRegistry {
	return &RigRegistry{
		rigs:    make(map[string]*Rig),
		helpers: make(map[string]int),
		dummies: make(map[string]bool),
	}
}

// HelperJoined increments the helper count for a rig name.  The first helper
// for a name causes a stub Rig entry to be created (Connected=false until the
// first update arrives).  Dummy rigs are unaffected by helpers.
func (r *RigRegistry) HelperJoined(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dummies[name] {
		return
	}
	r.helpers[name]++
	if _, ok := r.rigs[name]; !ok {
		r.rigs[name] = &Rig{Name: name, UpdatedAt: time.Now()}
	}
	r.rigs[name].HelperCount = r.helpers[name]
}

// HelperLeft decrements the helper count.  When it drops to zero the rig
// is removed from the registry; returns whether the rig still exists.
// Dummy rigs are unaffected by helpers.
func (r *RigRegistry) HelperLeft(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dummies[name] {
		return true
	}
	r.helpers[name]--
	if r.helpers[name] <= 0 {
		delete(r.helpers, name)
		delete(r.rigs, name)
		return false
	}
	if rig, ok := r.rigs[name]; ok {
		rig.HelperCount = r.helpers[name]
	}
	return true
}

// Update writes a new helper-reported state for an existing rig name.
// Dummy rigs ignore helper updates.
func (r *RigRegistry) Update(name string, freqHz int64, mode, errStr string) Rig {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dummies[name] {
		if rig, ok := r.rigs[name]; ok {
			return *rig
		}
		return Rig{}
	}
	rig, ok := r.rigs[name]
	if !ok {
		// Helper didn't go through HelperJoined first — be permissive.
		rig = &Rig{Name: name}
		r.rigs[name] = rig
	}
	rig.Connected = errStr == ""
	rig.Error = errStr
	rig.FreqHz = freqHz
	rig.Mode = mode
	rig.Band = BandFromHz(freqHz)
	rig.HelperCount = r.helpers[name]
	rig.UpdatedAt = time.Now()
	return *rig
}

// AddDummy adds a simulated TRX to the registry.  The rig appears as connected
// at the given default frequency and reacts to UpdateDummy calls (set_freq).
func (r *RigRegistry) AddDummy(name string, defaultFreqHz int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dummies[name] = true
	r.rigs[name] = &Rig{
		Name:      name,
		Dummy:     true,
		Connected: true,
		FreqHz:    defaultFreqHz,
		Mode:      "SSB",
		Band:      BandFromHz(defaultFreqHz),
		UpdatedAt: time.Now(),
	}
}

// RemoveDummy removes a simulated TRX from the registry.
// Returns false if the named rig is not a dummy.
func (r *RigRegistry) RemoveDummy(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.dummies[name] {
		return false
	}
	delete(r.dummies, name)
	delete(r.rigs, name)
	return true
}

// UpdateDummy sets the frequency and mode of a dummy rig directly (no helper involved).
// Returns false if the rig is not a dummy or does not exist.
func (r *RigRegistry) UpdateDummy(name string, freqHz int64, mode string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.dummies[name] {
		return false
	}
	rig, ok := r.rigs[name]
	if !ok {
		return false
	}
	if freqHz > 0 {
		rig.FreqHz = freqHz
		rig.Band = BandFromHz(freqHz)
	}
	if mode != "" {
		rig.Mode = mode
	}
	rig.UpdatedAt = time.Now()
	return true
}

// IsDummy reports whether the named rig is a simulated TRX.
func (r *RigRegistry) IsDummy(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dummies[name]
}

// HasRig reports whether a rig with the given name exists (real or dummy).
func (r *RigRegistry) HasRig(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.rigs[name]
	return ok
}

// All returns a snapshot of every known rig, sorted by name.
// inUseBy is a function returning the operator callsigns currently selecting
// the named rig (typically supplied by the Hub).
func (r *RigRegistry) All(inUseBy func(name string) []string) []Rig {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Rig, 0, len(r.rigs))
	for _, rig := range r.rigs {
		copy := *rig
		copy.InUseBy = inUseBy(rig.Name)
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// AllForContest is like All but separates same-contest usage from cross-contest usage.
// rigUsage returns (sameContestCallsigns, otherContestNames) for a rig name.
func (r *RigRegistry) AllForContest(rigUsage func(name string) ([]string, []string)) []Rig {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Rig, 0, len(r.rigs))
	for _, rig := range r.rigs {
		copy := *rig
		copy.InUseBy, copy.OtherContests = rigUsage(rig.Name)
		out = append(out, copy)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns one rig by name (or zero-value if unknown).
func (r *RigRegistry) Get(name string) (Rig, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rig, ok := r.rigs[name]; ok {
		return *rig, true
	}
	return Rig{}, false
}
