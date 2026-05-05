package server

import (
	"sort"
	"sync"
	"time"
)

// Rig is one transceiver as exposed by a connected helper.
// Identified by Name (e.g. "IC-7300").  Two helpers presenting the same name
// are coalesced into one entry (last write wins for the freq/mode fields).
type Rig struct {
	Name        string    `json:"name"`
	Connected   bool      `json:"connected"`
	Error       string    `json:"error,omitempty"`
	FreqHz      int64     `json:"freq_hz"`
	Mode        string    `json:"mode"`
	Band        string    `json:"band"`
	HelperCount int       `json:"helper_count"`
	InUseBy     []string  `json:"in_use_by"` // operator callsigns currently auto-filling from this rig
	UpdatedAt   time.Time `json:"updated_at"`
}

// RigRegistry keeps an in-memory map of rigs.  Rigs are added on the first
// helper update and removed when the last helper for that name disconnects.
// `InUseBy` is populated by the server using the hub's view of browser
// selections; the registry stores only what the helpers report.
type RigRegistry struct {
	mu      sync.Mutex
	rigs    map[string]*Rig
	helpers map[string]int // name -> count of currently connected helpers
}

// NewRigRegistry returns an empty registry.
func NewRigRegistry() *RigRegistry {
	return &RigRegistry{
		rigs:    make(map[string]*Rig),
		helpers: make(map[string]int),
	}
}

// HelperJoined increments the helper count for a rig name.  The first helper
// for a name causes a stub Rig entry to be created (Connected=false until the
// first update arrives).
func (r *RigRegistry) HelperJoined(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.helpers[name]++
	if _, ok := r.rigs[name]; !ok {
		r.rigs[name] = &Rig{Name: name, UpdatedAt: time.Now()}
	}
	r.rigs[name].HelperCount = r.helpers[name]
}

// HelperLeft decrements the helper count.  When it drops to zero the rig
// is removed from the registry; returns whether the rig still exists.
func (r *RigRegistry) HelperLeft(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
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
func (r *RigRegistry) Update(name string, freqHz int64, mode, errStr string) Rig {
	r.mu.Lock()
	defer r.mu.Unlock()
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

// Get returns one rig by name (or zero-value if unknown).
func (r *RigRegistry) Get(name string) (Rig, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rig, ok := r.rigs[name]; ok {
		return *rig, true
	}
	return Rig{}, false
}
