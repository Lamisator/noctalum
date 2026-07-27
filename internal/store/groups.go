package store

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// ErrGroupNotFound is returned when a lookup misses.
var ErrGroupNotFound = errors.New("group not found")

// ErrGroupNameTaken is returned by CreateGroup when the name is already in use.
var ErrGroupNameTaken = errors.New("group name already taken")

// Group is a reusable collection of users. Owners (group_members.is_owner)
// manage the membership and may rename or delete the group; regular members
// just inherit the group's contest access.
type Group struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedBy int64     `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	// Populated only when the caller asks for it (single-group view).
	Members []GroupMember `json:"members,omitempty"`
	// MemberCount is populated by ListGroups so the UI can render a badge
	// without a second round-trip.
	MemberCount int `json:"member_count,omitempty"`
	// MyRole is populated by ListGroups: "owner" | "member" | "" (not a
	// member). Used by the frontend to decide whether to show "Edit".
	MyRole string `json:"my_role,omitempty"`
}

// GroupMember is one user's membership in a group.
type GroupMember struct {
	GroupID  int64     `json:"group_id"`
	UserID   int64     `json:"user_id"`
	Username string    `json:"username"`
	Callsign string    `json:"callsign"`
	IsOwner  bool      `json:"is_owner"`
	AddedAt  time.Time `json:"added_at"`
}

// CreateGroup inserts a new group and adds createdBy as its first owner.
func (s *Store) CreateGroup(name string, createdBy int64) (*Group, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("group name required")
	}
	now := time.Now().UTC()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRow(
		`INSERT INTO groups (name, created_by, created_at) VALUES ($1, $2, $3) RETURNING id`,
		name, createdBy, now,
	).Scan(&id); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrGroupNameTaken
		}
		return nil, err
	}
	if _, err := tx.Exec(
		`INSERT INTO group_members (group_id, user_id, is_owner, added_at) VALUES ($1, $2, true, $3)`,
		id, createdBy, now,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Group{ID: id, Name: name, CreatedBy: createdBy, CreatedAt: now}, nil
}

// GetGroup returns a group with its members populated.
func (s *Store) GetGroup(id int64) (*Group, error) {
	row := s.db.QueryRow(
		`SELECT id, name, created_by, created_at FROM groups WHERE id = $1`, id)
	var g Group
	if err := row.Scan(&g.ID, &g.Name, &g.CreatedBy, &g.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, err
	}
	g.CreatedAt = g.CreatedAt.UTC()
	members, err := s.ListGroupMembers(id)
	if err != nil {
		return nil, err
	}
	g.Members = members
	return &g, nil
}

// ListGroups returns every group, ordered by name, with member counts and the
// caller's own role populated so the UI can render an overview page in one
// call. Pass userID=0 to skip the MyRole join.
func (s *Store) ListGroups(userID int64) ([]Group, error) {
	rows, err := s.db.Query(
		`SELECT g.id, g.name, g.created_by, g.created_at,
		        COALESCE((SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id), 0) AS member_count,
		        COALESCE((SELECT CASE WHEN is_owner THEN 'owner' ELSE 'member' END
		                  FROM group_members m WHERE m.group_id = g.id AND m.user_id = $1), '') AS my_role
		 FROM groups g
		 ORDER BY g.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Group
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Name, &g.CreatedBy, &g.CreatedAt, &g.MemberCount, &g.MyRole); err != nil {
			return nil, err
		}
		g.CreatedAt = g.CreatedAt.UTC()
		out = append(out, g)
	}
	return out, rows.Err()
}

// RenameGroup updates the name of an existing group.
func (s *Store) RenameGroup(id int64, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("group name required")
	}
	_, err := s.db.Exec(`UPDATE groups SET name = $1 WHERE id = $2`, name, id)
	if err != nil && isUniqueViolation(err) {
		return ErrGroupNameTaken
	}
	return err
}

// DeleteGroup removes a group and everything hanging off it.
func (s *Store) DeleteGroup(id int64) error {
	if _, err := s.db.Exec(`DELETE FROM group_members WHERE group_id = $1`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM contest_group_access WHERE group_id = $1`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM groups WHERE id = $1`, id)
	return err
}

// ListGroupMembers returns the group's members joined with user info.
func (s *Store) ListGroupMembers(groupID int64) ([]GroupMember, error) {
	rows, err := s.db.Query(
		`SELECT gm.group_id, gm.user_id, u.username, u.callsign, gm.is_owner, gm.added_at
		 FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = $1
		 ORDER BY gm.is_owner DESC, u.username`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupMember
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.GroupID, &m.UserID, &m.Username, &m.Callsign, &m.IsOwner, &m.AddedAt); err != nil {
			return nil, err
		}
		m.AddedAt = m.AddedAt.UTC()
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddGroupMember inserts a member (idempotent). isOwner controls whether the
// user has admin rights on the group.
func (s *Store) AddGroupMember(groupID, userID int64, isOwner bool) error {
	_, err := s.db.Exec(
		`INSERT INTO group_members (group_id, user_id, is_owner, added_at) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (group_id, user_id) DO UPDATE SET is_owner = EXCLUDED.is_owner`,
		groupID, userID, isOwner, time.Now().UTC(),
	)
	return err
}

// SetGroupMemberOwner flips a member's owner flag. Returns an error if the
// change would leave the group without any owners.
func (s *Store) SetGroupMemberOwner(groupID, userID int64, isOwner bool) error {
	if !isOwner {
		remaining, err := s.countOtherGroupOwners(groupID, userID)
		if err != nil {
			return err
		}
		if remaining == 0 {
			return errors.New("cannot demote the last owner of a group")
		}
	}
	_, err := s.db.Exec(
		`UPDATE group_members SET is_owner = $1 WHERE group_id = $2 AND user_id = $3`,
		isOwner, groupID, userID,
	)
	return err
}

// RemoveGroupMember deletes a member. Refuses to remove the last owner so a
// group can't be orphaned.
func (s *Store) RemoveGroupMember(groupID, userID int64) error {
	var isOwner bool
	err := s.db.QueryRow(
		`SELECT is_owner FROM group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	).Scan(&isOwner)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if isOwner {
		remaining, err := s.countOtherGroupOwners(groupID, userID)
		if err != nil {
			return err
		}
		if remaining == 0 {
			return errors.New("cannot remove the last owner of a group")
		}
	}
	_, err = s.db.Exec(
		`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	)
	return err
}

// IsGroupOwner returns true if userID is an owner of the group.
func (s *Store) IsGroupOwner(groupID, userID int64) (bool, error) {
	var isOwner bool
	err := s.db.QueryRow(
		`SELECT is_owner FROM group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	).Scan(&isOwner)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return isOwner, err
}

// IsGroupMember returns true if userID belongs to the group (owner or not).
func (s *Store) IsGroupMember(groupID, userID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) countOtherGroupOwners(groupID, excludeUserID int64) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM group_members
		 WHERE group_id = $1 AND is_owner = true AND user_id <> $2`,
		groupID, excludeUserID,
	).Scan(&n)
	return n, err
}

// ----- contest ↔ group access -----

// SetContestGroups replaces the set of groups that can access a contest.
// A no-op call (same set as before) is safe. The contest's visibility mode
// controls whether the association is meaningful; this store method just
// writes the association table.
func (s *Store) SetContestGroups(contestID int64, groupIDs []int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM contest_group_access WHERE contest_id = $1`, contestID); err != nil {
		return err
	}
	for _, gid := range groupIDs {
		if _, err := tx.Exec(
			`INSERT INTO contest_group_access (contest_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			contestID, gid,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetContestGroupIDs returns the group IDs currently granted access to a contest.
func (s *Store) GetContestGroupIDs(contestID int64) ([]int64, error) {
	rows, err := s.db.Query(
		`SELECT group_id FROM contest_group_access WHERE contest_id = $1 ORDER BY group_id`,
		contestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// GetContestGroups returns the groups currently granted access to a contest.
func (s *Store) GetContestGroups(contestID int64) ([]Group, error) {
	rows, err := s.db.Query(
		`SELECT g.id, g.name, g.created_by, g.created_at
		 FROM contest_group_access cga
		 JOIN groups g ON g.id = cga.group_id
		 WHERE cga.contest_id = $1
		 ORDER BY g.name`,
		contestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Group
	for rows.Next() {
		var g Group
		if err := rows.Scan(&g.ID, &g.Name, &g.CreatedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		g.CreatedAt = g.CreatedAt.UTC()
		out = append(out, g)
	}
	return out, rows.Err()
}

// UserInAnyContestGroup returns true if the user belongs to any group that
// has been granted access to the contest.
func (s *Store) UserInAnyContestGroup(contestID, userID int64) (bool, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT 1 FROM contest_group_access cga
		 JOIN group_members gm ON gm.group_id = cga.group_id
		 WHERE cga.contest_id = $1 AND gm.user_id = $2 LIMIT 1`,
		contestID, userID,
	).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
