package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/noctalum/noctalum/internal/store"
)

// handleContestShares handles the /api/contests/{id}/shares sub-route.  This
// is called from handleContestByID when sub starts with "shares".
// Methods:
//   GET    /api/contests/{id}/shares             — list shares for the contest
//   POST   /api/contests/{id}/shares             — create a new share
//   DELETE /api/contests/{id}/shares/{token}     — revoke a share
func (s *Server) handleContestShares(w http.ResponseWriter, r *http.Request, contestID int64, sub string) {
	sess := sessionFor(s, r)
	c, err := s.store.GetContest(contestID)
	if errors.Is(err, store.ErrContestNotFound) {
		writeError(w, http.StatusNotFound, "contest not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Only owners + contest-write managers can create / revoke / list shares.
	canManage := HasPermission(sess.Permissions, PermContestsManage)
	canManagePrivate := HasPermission(sess.Permissions, PermContestsManagePrivate)
	isAdmin := HasPermission(sess.Permissions, PermContestAdmin)
	isOwner := c.OwnerUserID != 0 && c.OwnerUserID == sess.UserID
	if !isOwner {
		ownerPart, _ := s.store.GetContestParticipant(contestID, sess.UserID)
		if ownerPart != nil && ownerPart.Role == "owner" && ownerPart.Status == "active" {
			isOwner = true
		}
	}
	canWrite := isAdmin || isOwner || canManage || (canManagePrivate && c.Private)
	if !canWrite {
		s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, c.Name, "share: write access denied")
		writeError(w, http.StatusForbidden, "you do not have permission to share this contest")
		return
	}

	// Sub-paths under shares/
	if sub == "shares" {
		switch r.Method {
		case http.MethodGet:
			shares, err := s.store.ListSharesByContest(contestID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			// Strip the payload from the list response — it's large and not needed
			// for the listing UI.  Callers can fetch a single share to inspect it.
			type shareSummary struct {
				Token       string `json:"token"`
				SourceName  string `json:"source_name"`
				CreatedAt   string `json:"created_at"`
				OwnerUserID int64  `json:"owner_user_id"`
			}
			out := make([]shareSummary, 0, len(shares))
			for _, sh := range shares {
				out = append(out, shareSummary{
					Token:       sh.Token,
					SourceName:  sh.SourceName,
					CreatedAt:   sh.CreatedAt.Format("2006-01-02T15:04:05Z"),
					OwnerUserID: sh.OwnerUserID,
				})
			}
			writeJSON(w, http.StatusOK, out)
			return
		case http.MethodPost:
			payload, err := store.BuildSharePayload(c)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			sh, err := s.store.CreateShare(contestID, sess.UserID, c.Name, payload)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			s.audit(r, store.AuditInfo, AuditContestUpdate, sess.Username, c.Name, "share created: "+sh.Token)
			writeJSON(w, http.StatusCreated, map[string]any{
				"token":       sh.Token,
				"source_name": sh.SourceName,
				"created_at":  sh.CreatedAt.Format("2006-01-02T15:04:05Z"),
			})
			return
		}
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// DELETE /api/contests/{id}/shares/{token}
	if strings.HasPrefix(sub, "shares/") && r.Method == http.MethodDelete {
		token := strings.TrimPrefix(sub, "shares/")
		if token == "" {
			writeError(w, http.StatusBadRequest, "share token required")
			return
		}
		existing, err := s.store.GetShare(token)
		if errors.Is(err, store.ErrShareNotFound) {
			writeError(w, http.StatusNotFound, "share not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if existing.ContestID != contestID {
			writeError(w, http.StatusBadRequest, "share does not belong to this contest")
			return
		}
		if err := s.store.DeleteShare(token); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditContestUpdate, sess.Username, c.Name, "share revoked: "+token)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

// handleSharePreview serves GET /api/share/{token} — a public endpoint that
// returns metadata + payload summary so an importer can decide whether to
// proceed.  No authentication required (tokens are unguessable bearer
// credentials and the payload contains no PII).
func (s *Server) handleSharePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/api/share/")
	if token == "" || strings.Contains(token, "/") {
		writeError(w, http.StatusBadRequest, "share token required")
		return
	}
	sh, err := s.store.GetShare(token)
	if errors.Is(err, store.ErrShareNotFound) {
		writeError(w, http.StatusNotFound, "share not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Parse the payload to surface a summary the UI can render before the
	// importer commits — number of custom fields, layout tiles, bands.
	var p store.SharePayload
	_ = json.Unmarshal([]byte(sh.Payload), &p)
	nFields := countJSONArray(p.CustomFields)
	nLayout := countLayoutItems(p.QSOLayout)
	writeJSON(w, http.StatusOK, map[string]any{
		"token":       sh.Token,
		"source_name": sh.SourceName,
		"created_at":  sh.CreatedAt.Format("2006-01-02T15:04:05Z"),
		"summary": map[string]any{
			"custom_field_count": nFields,
			"layout_item_count":  nLayout,
			"bands":              p.Bands,
			"nr_padded":          p.NrPadded,
		},
	})
}

// handleImportShare serves POST /api/import-share — auth-required endpoint
// that materialises a share into a new contest for the calling operator.
// Body: {"token":"...","name":"...","station_call":"...","qth":"..."}
func (s *Server) handleImportShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	var in struct {
		Token       string `json:"token"`
		Name        string `json:"name"`
		StationCall string `json:"station_call"`
		QTH         string `json:"qth"`
		Private     bool   `json:"private"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	in.Token = strings.TrimSpace(in.Token)
	in.Name = strings.TrimSpace(in.Name)
	if in.Token == "" {
		writeError(w, http.StatusBadRequest, "token required")
		return
	}
	if in.Name == "" {
		writeError(w, http.StatusBadRequest, "contest name required")
		return
	}
	if !ValidCallsign(in.StationCall) {
		writeError(w, http.StatusBadRequest, "invalid station callsign")
		return
	}
	qth := strings.ToUpper(strings.TrimSpace(in.QTH))
	if qth != "" && !ValidLocator(qth) {
		writeError(w, http.StatusBadRequest, "invalid QTH locator")
		return
	}
	// Creation permission: the importer is creating a contest, so they need
	// the same perm as for /api/contests POST.
	canManage := HasPermission(sess.Permissions, PermContestsManage)
	canCreatePrivate := HasPermission(sess.Permissions, PermContestsCreatePrivate) || HasPermission(sess.Permissions, PermContestsManagePrivate)
	if in.Private {
		if !canManage && !canCreatePrivate {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, PermContestsCreatePrivate, "import-share private")
			writeError(w, http.StatusForbidden, "missing permission: "+PermContestsCreatePrivate)
			return
		}
	} else if !canManage {
		s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, PermContestsManage, "import-share public")
		writeError(w, http.StatusForbidden, "missing permission: "+PermContestsManage)
		return
	}
	sh, err := s.store.GetShare(in.Token)
	if errors.Is(err, store.ErrShareNotFound) {
		writeError(w, http.StatusNotFound, "share not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var p store.SharePayload
	if err := json.Unmarshal([]byte(sh.Payload), &p); err != nil {
		writeError(w, http.StatusInternalServerError, "share payload corrupted: "+err.Error())
		return
	}
	ownerID := int64(0)
	if in.Private {
		ownerID = sess.UserID
	}
	c, err := s.store.CreateContest(
		in.Name,
		in.StationCall,
		qth,
		p.Bands,
		p.Objective,
		"",
		in.Private,
		ownerID,
		p.CustomFields,
		p.QSOLayout,
		p.LogColumns,
		p.NrPadded,
		p.StashExpiryMinutes,
		p.FreqUnit,
	)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.store.AddContestParticipant(c.ID, sess.UserID, "owner", "active")
	s.audit(r, store.AuditInfo, AuditContestCreate, sess.Username, c.Name, "imported from share: "+sh.Token+" (source: "+sh.SourceName+")")
	writeJSON(w, http.StatusCreated, c)
}

// countJSONArray returns the element count of the top-level JSON array in s,
// or 0 if s does not parse as one.  Used for share-payload summaries.
func countJSONArray(s string) int {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return 0
	}
	return len(arr)
}

// countLayoutItems parses a QSO layout JSON and returns len(.items).
func countLayoutItems(s string) int {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	var layout struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(s), &layout); err != nil {
		return 0
	}
	return len(layout.Items)
}

