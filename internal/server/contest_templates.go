package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/noctalum/noctalum/internal/store"
)

// Contest-template endpoints:
//
//	GET    /api/contest-templates        list the caller's own + all shared templates
//	POST   /api/contest-templates        create a template (requires contest_templates.manage)
//	GET    /api/contest-templates/{id}   read one template the caller may use
//	PUT    /api/contest-templates/{id}   update (template owner, or contests.manage)
//	DELETE /api/contest-templates/{id}   delete (template owner, or contests.manage)
//
// Templates are a pure convenience layer: they pre-fill the create-contest
// dialog and are never consulted again afterwards, so a contest created from
// a template survives that template being edited or deleted. Reads are open
// to every authenticated user (you cannot see someone else's unshared
// template because the list/get queries filter it out); writes need the
// contest_templates.manage permission, which the default "user" role carries
// so ordinary operators can keep their own catalogue.
//
// "admin" for the edit/delete override is contests.manage — the same
// permission that governs contest creation, since a template is really just a
// stored contest shape.

// canManageTemplate reports whether sess may edit or delete t. Built-in
// templates (owner_user_id 0) have no owner, so only a contests.manage admin
// can touch them.
func (s *Server) canManageTemplate(sess *Session, t *store.ContestTemplate) bool {
	if HasPermission(sess.Permissions, PermContestsManage) || HasPermission(sess.Permissions, PermContestAdmin) {
		return true
	}
	return t.OwnerUserID != 0 && t.OwnerUserID == sess.UserID
}

// canUseTemplate reports whether sess may read t at all — its owner, anyone
// when it is shared, or a contests.manage admin.
func (s *Server) canUseTemplate(sess *Session, t *store.ContestTemplate) bool {
	if t.Shared {
		return true
	}
	return s.canManageTemplate(sess, t)
}

// decodeTemplate reads a template payload from the request body. It never
// trusts the client for ownership: owner_user_id and the shared flag on
// updates are applied by the caller, not taken verbatim here.
func decodeTemplate(r *http.Request) (*store.ContestTemplate, error) {
	var in struct {
		Name               string   `json:"name"`
		DefaultName        string   `json:"default_name"`
		Bands              []string `json:"bands"`
		Objective          string   `json:"objective"`
		CustomFields       string   `json:"custom_fields"`
		QSOLayout          string   `json:"qso_layout"`
		LogColumns         string   `json:"log_columns"`
		NrPadded           *bool    `json:"nr_padded"`
		FreqUnit           string   `json:"freq_unit"`
		StashExpiryMinutes *int64   `json:"stash_expiry_minutes"`
		Shared             bool     `json:"shared"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		return nil, errors.New("invalid JSON")
	}
	t := &store.ContestTemplate{
		Name:         strings.TrimSpace(in.Name),
		DefaultName:  strings.TrimSpace(in.DefaultName),
		Bands:        in.Bands,
		Objective:    in.Objective,
		CustomFields: in.CustomFields,
		QSOLayout:    in.QSOLayout,
		LogColumns:   in.LogColumns,
		FreqUnit:     in.FreqUnit,
		Shared:       in.Shared,
		NrPadded:     true,
	}
	if in.NrPadded != nil {
		t.NrPadded = *in.NrPadded
	}
	if in.StashExpiryMinutes != nil {
		t.StashExpiryMinutes = *in.StashExpiryMinutes
	}
	if t.Name == "" {
		return nil, errors.New("template name required")
	}
	// Reject blobs that aren't valid JSON before they reach the DB — the
	// frontend editors always produce well-formed arrays/objects, so a
	// malformed value means a hand-rolled request that would otherwise sit
	// in the table and break every create-contest dialog that loads it.
	for _, blob := range []string{t.CustomFields, t.QSOLayout, t.LogColumns} {
		if blob == "" {
			continue
		}
		if !json.Valid([]byte(blob)) {
			return nil, errors.New("custom_fields, qso_layout and log_columns must be valid JSON")
		}
	}
	return t, nil
}

func (s *Server) handleContestTemplates(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	switch r.Method {
	case http.MethodGet:
		list, err := s.store.ListContestTemplates(sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if list == nil {
			list = []store.ContestTemplate{}
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		if !HasPermission(sess.Permissions, PermContestTemplatesManage) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, PermContestTemplatesManage, "create contest template")
			writeError(w, http.StatusForbidden, "missing permission: "+PermContestTemplatesManage)
			return
		}
		t, err := decodeTemplate(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		created, err := s.store.CreateContestTemplate(t, sess.UserID)
		if errors.Is(err, store.ErrTemplateNameTaken) {
			writeError(w, http.StatusConflict, "you already have a template with that name")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditContestTemplateCreate, sess.Username, created.Name, "")
		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleContestTemplateByID(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/api/contest-templates/")
	id, err := strconv.ParseInt(strings.TrimSuffix(idStr, "/"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid template id")
		return
	}
	sess := sessionFor(s, r)
	existing, err := s.store.GetContestTemplate(id)
	if errors.Is(err, store.ErrTemplateNotFound) {
		writeError(w, http.StatusNotFound, "contest template not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	switch r.Method {
	case http.MethodGet:
		if !s.canUseTemplate(sess, existing) {
			writeError(w, http.StatusNotFound, "contest template not found")
			return
		}
		writeJSON(w, http.StatusOK, existing)
	case http.MethodPut:
		if !s.canManageTemplate(sess, existing) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, existing.Name, "edit contest template")
			writeError(w, http.StatusForbidden, "only the template owner or an admin can edit this template")
			return
		}
		t, err := decodeTemplate(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := s.store.UpdateContestTemplate(id, t); err != nil {
			if errors.Is(err, store.ErrTemplateNameTaken) {
				writeError(w, http.StatusConflict, "you already have a template with that name")
				return
			}
			if errors.Is(err, store.ErrTemplateNotFound) {
				writeError(w, http.StatusNotFound, "contest template not found")
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditContestTemplateUpdate, sess.Username, t.Name, "")
		updated, err := s.store.GetContestTemplate(id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if !s.canManageTemplate(sess, existing) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, existing.Name, "delete contest template")
			writeError(w, http.StatusForbidden, "only the template owner or an admin can delete this template")
			return
		}
		if err := s.store.DeleteContestTemplate(id); err != nil {
			if errors.Is(err, store.ErrTemplateNotFound) {
				writeError(w, http.StatusNotFound, "contest template not found")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditContestTemplateDelete, sess.Username, existing.Name, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
