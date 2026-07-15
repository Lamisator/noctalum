package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/noctalum/noctalum/internal/store"
)

// Maximum accepted proof upload size: 5 MB. Chosen large enough for a
// smartphone scan of a licence PDF but small enough to bound disk usage
// per pending request.
const callsignProofMaxSize = 5 << 20

// allowedCallsignProofExts maps the accepted file extensions to their
// canonical MIME types. Anything not in this map is rejected — the whole
// point of the proof is to be a licence document, not an arbitrary blob.
var allowedCallsignProofExts = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".pdf":  "application/pdf",
}

// handleMeCallsignRequest is the per-user endpoint: GET returns the caller's
// outstanding pending request (or 204 No Content if none); POST submits a
// new request with a multipart proof upload; DELETE withdraws the caller's
// pending request. Approve/decline is handled by the admin endpoint below.
func (s *Server) handleMeCallsignRequest(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	switch r.Method {
	case http.MethodGet:
		cr, err := s.store.GetPendingCallsignRequestByUser(sess.UserID)
		if errors.Is(err, store.ErrNotFound) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Never leak the on-disk filename to the requester — only admins
		// need it (they'll fetch via /api/callsign-requests/{id}/proof).
		cr.ProofFilename = ""
		writeJSON(w, http.StatusOK, cr)

	case http.MethodPost:
		s.submitCallsignRequest(w, r, sess)

	case http.MethodDelete:
		cr, err := s.store.GetPendingCallsignRequestByUser(sess.UserID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no pending request")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Reject with an admin_note so we keep the row for the audit
		// trail but the request no longer blocks a new submission.
		if err := s.store.DecideCallsignRequest(cr.ID, sess.UserID, "rejected", "withdrawn by user"); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.removeCallsignProof(cr.ProofFilename)
		s.audit(r, store.AuditInfo, AuditCallsignRequestWithdraw, sess.Username, cr.RequestedCallsign,
			"withdrew pending request #"+strconv.FormatInt(cr.ID, 10))
		w.WriteHeader(http.StatusNoContent)

	default:
		writeError(w, http.StatusMethodNotAllowed, "GET, POST or DELETE required")
	}
}

func (s *Server) submitCallsignRequest(w http.ResponseWriter, r *http.Request, sess *Session) {
	if s.callsignProofsDir == "" {
		writeError(w, http.StatusInternalServerError, "callsign proofs directory not configured")
		return
	}
	// One in-flight request per user — otherwise admins would have to
	// wade through a queue of duplicates from the same account.
	if _, err := s.store.GetPendingCallsignRequestByUser(sess.UserID); err == nil {
		writeError(w, http.StatusConflict, "you already have a pending callsign change request; withdraw it first")
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Cap the entire request body first — ParseMultipartForm's argument
	// is only the in-memory threshold and would happily spill an
	// unlimited payload to /tmp.
	r.Body = http.MaxBytesReader(w, r.Body, callsignProofMaxSize+64<<10)
	if err := r.ParseMultipartForm(callsignProofMaxSize); err != nil {
		writeError(w, http.StatusBadRequest, "file too large (max 5 MB) or malformed upload")
		return
	}

	requested := strings.ToUpper(strings.TrimSpace(r.FormValue("callsign")))
	if !ValidCallsign(requested) {
		writeError(w, http.StatusBadRequest, "requested callsign is not a valid amateur radio callsign")
		return
	}
	if requested == strings.ToUpper(sess.Callsign) {
		writeError(w, http.StatusBadRequest, "requested callsign is the same as your current callsign")
		return
	}

	f, hdr, err := r.FormFile("proof")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing file field 'proof'")
		return
	}
	defer f.Close()
	if hdr.Size <= 0 {
		writeError(w, http.StatusBadRequest, "empty proof file")
		return
	}
	if hdr.Size > callsignProofMaxSize {
		writeError(w, http.StatusBadRequest, "file too large (max 5 MB)")
		return
	}
	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	mime, ok := allowedCallsignProofExts[ext]
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported file type; allowed: jpg, png, pdf")
		return
	}

	// Random filename stops any interaction with the original name and
	// keeps the proofs dir listing anonymous — the (userID, requestID) tie
	// lives only in the database.
	safe := newToken() + ext
	dest := filepath.Join(s.callsignProofsDir, safe)
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create proof file")
		return
	}
	written, copyErr := io.Copy(out, f)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(dest)
		writeError(w, http.StatusInternalServerError, "could not write proof file")
		return
	}

	id, err := s.store.InsertCallsignRequest(sess.UserID, sess.Callsign, requested, safe, mime, written)
	if err != nil {
		_ = os.Remove(dest)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditCallsignRequestCreate, sess.Username, requested,
		"request #"+strconv.FormatInt(id, 10)+" from "+sess.Callsign+" to "+requested)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "pending"})
}

// handleCallsignRequests is the admin endpoint that lists every request
// (pending first, decided ones below) for reviewers with the
// callsign_requests.review permission.
func (s *Server) handleCallsignRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	list, err := s.store.ListCallsignRequests()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if list == nil {
		list = []store.CallsignRequest{}
	}
	// Strip the on-disk filename from the payload; admins fetch the file
	// via /api/callsign-requests/{id}/proof and never need the raw name.
	for i := range list {
		list[i].ProofFilename = ""
	}
	writeJSON(w, http.StatusOK, list)
}

// handleCallsignRequestByID routes /api/callsign-requests/{id}[/proof|/decide].
func (s *Server) handleCallsignRequestByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/callsign-requests/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "request id required")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	switch sub {
	case "proof":
		s.serveCallsignProof(w, r, id)
	case "decide":
		s.decideCallsignRequest(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "unknown action")
	}
}

func (s *Server) serveCallsignProof(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	if s.callsignProofsDir == "" {
		writeError(w, http.StatusInternalServerError, "callsign proofs directory not configured")
		return
	}
	cr, err := s.store.GetCallsignRequestByID(id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if cr.ProofFilename == "" {
		writeError(w, http.StatusNotFound, "no proof on file")
		return
	}
	// Defence-in-depth: proof filenames are opaque tokens we generated,
	// but callers should never be able to escape the proofs dir.
	name := filepath.Base(cr.ProofFilename)
	fpath := filepath.Join(s.callsignProofsDir, name)
	if cr.ProofMime != "" {
		w.Header().Set("Content-Type", cr.ProofMime)
	}
	// Inline so admins can preview images and PDFs directly in a new tab.
	w.Header().Set("Content-Disposition", "inline")
	http.ServeFile(w, r, fpath)
}

func (s *Server) decideCallsignRequest(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	sess := sessionFor(s, r)
	var body struct {
		Decision string `json:"decision"` // "approve" | "reject"
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	var status string
	switch strings.ToLower(strings.TrimSpace(body.Decision)) {
	case "approve", "approved":
		status = "approved"
	case "reject", "rejected", "decline", "declined":
		status = "rejected"
	default:
		writeError(w, http.StatusBadRequest, "decision must be 'approve' or 'reject'")
		return
	}

	cr, err := s.store.GetCallsignRequestByID(id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if cr.Status != "pending" {
		writeError(w, http.StatusConflict, "request already "+cr.Status)
		return
	}

	if status == "approved" {
		if err := s.store.SetCallsign(cr.UserID, cr.RequestedCallsign); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Push the new callsign into every live session belonging to
		// the requester so the topbar and outgoing chat messages
		// update without a re-login.
		if u, err := s.store.GetUserByID(cr.UserID); err == nil {
			s.sessions.RefreshUser(u)
		}
	}

	note := strings.TrimSpace(body.Note)
	if err := s.store.DecideCallsignRequest(id, sess.UserID, status, note); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "request already decided")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Free the disk copy of the proof once the decision is recorded —
	// keeping it after a decision has no operational value and just adds
	// storage / privacy exposure.
	s.removeCallsignProof(cr.ProofFilename)

	action := AuditCallsignRequestApprove
	if status == "rejected" {
		action = AuditCallsignRequestReject
	}
	details := "request #" + strconv.FormatInt(id, 10) + " for " + cr.Username +
		" (" + cr.CurrentCallsign + " -> " + cr.RequestedCallsign + ")"
	if note != "" {
		details += "; note: " + note
	}
	s.audit(r, store.AuditInfo, action, sess.Username, cr.Username, details)
	writeJSON(w, http.StatusOK, map[string]any{"status": status})
}

func (s *Server) removeCallsignProof(name string) {
	if name == "" || s.callsignProofsDir == "" {
		return
	}
	safe := filepath.Base(name)
	_ = os.Remove(filepath.Join(s.callsignProofsDir, safe))
}
