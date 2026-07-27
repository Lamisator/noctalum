package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/noctalum/noctalum/internal/store"
)

// Groups endpoints:
//
//   GET    /api/groups                              list groups (any authed user)
//   POST   /api/groups                              create a group (requires groups.manage)
//   GET    /api/groups/{id}                         group detail incl. members
//   PUT    /api/groups/{id}                         rename group (group owner or admin)
//   DELETE /api/groups/{id}                         delete group (group owner or admin)
//   POST   /api/groups/{id}/members                 add a member (group owner or admin)
//   DELETE /api/groups/{id}/members/{userID}        remove a member (group owner or admin)
//   PUT    /api/groups/{id}/members/{userID}        change owner flag (group owner or admin)
//
// "admin" here means users.manage — the same permission that already governs
// the Users tab, chosen because deleting a group is fundamentally a
// user-management action (it can strip access from many contests at once).

func (s *Server) handleGroups(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	switch r.Method {
	case http.MethodGet:
		groups, err := s.store.ListGroups(sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if groups == nil {
			groups = []store.Group{}
		}
		writeJSON(w, http.StatusOK, groups)
	case http.MethodPost:
		if !HasPermission(sess.Permissions, PermGroupsManage) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, PermGroupsManage, "create group")
			writeError(w, http.StatusForbidden, "missing permission: "+PermGroupsManage)
			return
		}
		var in struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		g, err := s.store.CreateGroup(in.Name, sess.UserID)
		if errors.Is(err, store.ErrGroupNameTaken) {
			writeError(w, http.StatusConflict, "group name already in use")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditGroupCreate, sess.Username, g.Name, "")
		writeJSON(w, http.StatusCreated, g)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleGroupByID dispatches /api/groups/{id} and its /members/{userID}
// sub-route.
func (s *Server) handleGroupByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/groups/")
	parts := strings.SplitN(rest, "/", 3)
	idStr := parts[0]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid group id")
		return
	}
	sess := sessionFor(s, r)

	// Members sub-route.
	if len(parts) >= 2 && parts[1] == "members" {
		s.handleGroupMembers(w, r, sess, id, parts)
		return
	}

	switch r.Method {
	case http.MethodGet:
		g, err := s.store.GetGroup(id)
		if errors.Is(err, store.ErrGroupNotFound) {
			writeError(w, http.StatusNotFound, "group not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, g)
	case http.MethodPut:
		if !s.canManageGroup(sess, id) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, idStr, "rename group")
			writeError(w, http.StatusForbidden, "only group owners or admins can rename this group")
			return
		}
		var in struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := s.store.RenameGroup(id, in.Name); err != nil {
			if errors.Is(err, store.ErrGroupNameTaken) {
				writeError(w, http.StatusConflict, "group name already in use")
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditGroupUpdate, sess.Username, in.Name, "renamed")
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if !s.canManageGroup(sess, id) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, idStr, "delete group")
			writeError(w, http.StatusForbidden, "only group owners or admins can delete this group")
			return
		}
		g, _ := s.store.GetGroup(id)
		if err := s.store.DeleteGroup(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		name := idStr
		if g != nil {
			name = g.Name
		}
		s.audit(r, store.AuditWarn, AuditGroupDelete, sess.Username, name, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleGroupMembers(w http.ResponseWriter, r *http.Request, sess *Session, groupID int64, parts []string) {
	// POST /api/groups/{id}/members  → add a member
	if len(parts) == 2 && r.Method == http.MethodPost {
		if !s.canManageGroup(sess, groupID) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, strconv.FormatInt(groupID, 10), "add group member")
			writeError(w, http.StatusForbidden, "only group owners or admins can add members")
			return
		}
		var in struct {
			UserID   int64  `json:"user_id"`
			Username string `json:"username"`
			IsOwner  bool   `json:"is_owner"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		targetID := in.UserID
		if targetID == 0 && in.Username != "" {
			u, err := s.store.GetUserByUsername(in.Username)
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "user not found")
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			targetID = u.ID
		}
		if targetID == 0 {
			writeError(w, http.StatusBadRequest, "user_id or username required")
			return
		}
		if err := s.store.AddGroupMember(groupID, targetID, in.IsOwner); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditGroupMemberAdd, sess.Username, strconv.FormatInt(groupID, 10),
			fmt.Sprintf("user_id: %d is_owner: %v", targetID, in.IsOwner))
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// PUT / DELETE /api/groups/{id}/members/{userID}
	if len(parts) < 3 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	targetID, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}

	switch r.Method {
	case http.MethodPut:
		if !s.canManageGroup(sess, groupID) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, strconv.FormatInt(groupID, 10), "change group member role")
			writeError(w, http.StatusForbidden, "only group owners or admins can change member roles")
			return
		}
		var in struct {
			IsOwner bool `json:"is_owner"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := s.store.SetGroupMemberOwner(groupID, targetID, in.IsOwner); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditGroupMemberRoleChange, sess.Username, strconv.FormatInt(groupID, 10),
			fmt.Sprintf("user_id: %d is_owner: %v", targetID, in.IsOwner))
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		// Members may remove themselves; otherwise the caller needs
		// manage rights on the group.
		if targetID != sess.UserID && !s.canManageGroup(sess, groupID) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, strconv.FormatInt(groupID, 10), "remove group member")
			writeError(w, http.StatusForbidden, "only group owners or admins can remove other members")
			return
		}
		if err := s.store.RemoveGroupMember(groupID, targetID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditGroupMemberRemove, sess.Username, strconv.FormatInt(groupID, 10),
			fmt.Sprintf("user_id: %d", targetID))
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// canManageGroup returns true if the session may rename, delete, add
// members to, or change roles in the given group. Rule: the caller must be
// an owner of the group or hold users.manage.
func (s *Server) canManageGroup(sess *Session, groupID int64) bool {
	if HasPermission(sess.Permissions, PermUsersManage) {
		return true
	}
	ok, err := s.store.IsGroupOwner(groupID, sess.UserID)
	return err == nil && ok
}
