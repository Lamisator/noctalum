// noctalum-notify-telegram announces a Noctalum deploy to a Telegram group.
//
// It reads the latest changelog entry from internal/server/web/app.js — the
// bilingual source of truth for the web UI — and posts the German body to the
// configured Telegram group via the Bot HTTPS API. Configuration (bot token,
// chat id, last-posted version) lives in ~/.config/noctalum/telegram.json
// (chmod 0600); run --setup once to create it.
//
// The notifier never aborts a deploy: any failure prints a warning to stderr
// and exits 0. Use --dry-run to preview, --force to repost the latest entry,
// or --version X.Y to post a specific older entry.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"
)

const telegramAPI = "https://api.telegram.org"

type config struct {
	BotToken          string `json:"bot_token"`
	ChatID            int64  `json:"chat_id"`
	ChatTitle         string `json:"chat_title,omitempty"`
	LastPostedVersion string `json:"last_posted_version,omitempty"`
}

type entry struct {
	Version string
	Date    string
	En      string
	De      string
}

func main() {
	setup := flag.Bool("setup", false, "interactive first-run wizard")
	dryRun := flag.Bool("dry-run", false, "print rendered message to stdout, do not post or update state")
	force := flag.Bool("force", false, "post even if last_posted_version matches the latest entry")
	pickVer := flag.String("version", "", "post a specific changelog version instead of the latest (e.g. 0.42)")
	changelog := flag.String("changelog", "", "path to app.js (defaults to autodetect)")
	flag.Parse()

	if *setup {
		if err := runSetup(); err != nil {
			fmt.Fprintln(os.Stderr, "setup aborted:", err)
			os.Exit(1)
		}
		return
	}

	if err := runPost(*changelog, *pickVer, *dryRun, *force); err != nil {
		fmt.Fprintln(os.Stderr, "warning: telegram notification failed:", err)
	}
}

// ── Config ────────────────────────────────────────────────────────────────

func configPath() string {
	if p := os.Getenv("NOCTALUM_TELEGRAM_CONFIG"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "noctalum", "telegram.json")
}

func loadConfig() (*config, error) {
	path := configPath()
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("refusing to read %s — permissions %o are too open (want 0600)", path, info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.BotToken == "" || c.ChatID == 0 {
		return nil, fmt.Errorf("%s is missing bot_token or chat_id — run --setup", path)
	}
	return &c, nil
}

func saveConfig(c *config) error {
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── Changelog parsing ─────────────────────────────────────────────────────

func resolveChangelogPath(override string) (string, error) {
	if override != "" {
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("--changelog %s: %w", override, err)
		}
		return override, nil
	}
	if root := os.Getenv("NOCTALUM_REPO_ROOT"); root != "" {
		p := filepath.Join(root, "internal", "server", "web", "app.js")
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, exe)
	}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, filepath.Join(cwd, "x"))
	}
	for _, start := range starts {
		dir := filepath.Dir(start)
		for {
			p := filepath.Join(dir, "internal", "server", "web", "app.js")
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", errors.New("could not locate internal/server/web/app.js; pass --changelog PATH")
}

func parseChangelog(path string) ([]entry, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	src := string(raw)
	const marker = "const CHANGELOG = ["
	idx := strings.Index(src, marker)
	if idx < 0 {
		return nil, fmt.Errorf("CHANGELOG marker not found in %s", path)
	}
	src = src[idx+len(marker):]

	var entries []entry
	i := 0
	for i < len(src) {
		for i < len(src) && (src[i] == ' ' || src[i] == '\t' || src[i] == '\n' || src[i] == '\r' || src[i] == ',') {
			i++
		}
		if i >= len(src) || src[i] == ']' {
			break
		}
		if src[i] != '{' {
			return nil, fmt.Errorf("unexpected character %q at offset %d while scanning CHANGELOG", src[i], i)
		}
		end, obj, err := scanObject(src[i:])
		if err != nil {
			return nil, err
		}
		e, err := parseEntry(obj)
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
		i += end
	}
	if len(entries) == 0 {
		return nil, errors.New("CHANGELOG array is empty")
	}
	return entries, nil
}

// scanObject reads from "{" through the matching "}", honouring JS string
// delimiters and backslash escapes.
func scanObject(s string) (int, string, error) {
	if len(s) == 0 || s[0] != '{' {
		return 0, "", errors.New("scanObject: expected '{'")
	}
	depth := 0
	i := 0
	for i < len(s) {
		c := s[i]
		switch c {
		case '{':
			depth++
			i++
		case '}':
			depth--
			i++
			if depth == 0 {
				return i, s[:i], nil
			}
		case '\'', '"', '`':
			quote := c
			i++
			for i < len(s) && s[i] != quote {
				if s[i] == '\\' && i+1 < len(s) {
					i += 2
					continue
				}
				i++
			}
			if i >= len(s) {
				return 0, "", errors.New("unterminated string in CHANGELOG object")
			}
			i++
		default:
			i++
		}
	}
	return 0, "", errors.New("unterminated object in CHANGELOG")
}

// parseEntry walks a "{ key: '...', ... }" object literal, extracting the
// fields we care about. We avoid substring lookups like strings.Index("en:")
// because a German body could plausibly contain those bytes.
func parseEntry(obj string) (entry, error) {
	if len(obj) < 2 || obj[0] != '{' || obj[len(obj)-1] != '}' {
		return entry{}, errors.New("parseEntry: expected braces around object")
	}
	inner := obj[1 : len(obj)-1]
	var e entry
	i := 0
	for i < len(inner) {
		for i < len(inner) && (inner[i] == ' ' || inner[i] == '\t' || inner[i] == '\n' || inner[i] == '\r' || inner[i] == ',') {
			i++
		}
		if i >= len(inner) {
			break
		}
		ks := i
		for i < len(inner) && (inner[i] == '_' ||
			(inner[i] >= 'a' && inner[i] <= 'z') ||
			(inner[i] >= 'A' && inner[i] <= 'Z') ||
			(inner[i] >= '0' && inner[i] <= '9')) {
			i++
		}
		if i == ks {
			return entry{}, fmt.Errorf("parseEntry: expected key at offset %d", i)
		}
		key := inner[ks:i]
		for i < len(inner) && (inner[i] == ' ' || inner[i] == '\t') {
			i++
		}
		if i >= len(inner) || inner[i] != ':' {
			return entry{}, fmt.Errorf("parseEntry: expected ':' after %q", key)
		}
		i++
		for i < len(inner) && (inner[i] == ' ' || inner[i] == '\t') {
			i++
		}
		if i >= len(inner) {
			return entry{}, fmt.Errorf("parseEntry: missing value for %q", key)
		}
		quote := inner[i]
		if quote != '\'' && quote != '"' && quote != '`' {
			return entry{}, fmt.Errorf("parseEntry: value for %q is not a string", key)
		}
		i++
		var b strings.Builder
		for i < len(inner) && inner[i] != quote {
			if inner[i] == '\\' && i+1 < len(inner) {
				switch inner[i+1] {
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				case 'r':
					b.WriteByte('\r')
				default:
					b.WriteByte(inner[i+1])
				}
				i += 2
				continue
			}
			b.WriteByte(inner[i])
			i++
		}
		if i >= len(inner) {
			return entry{}, fmt.Errorf("parseEntry: unterminated string for %q", key)
		}
		i++ // past closing quote
		switch key {
		case "version":
			e.Version = b.String()
		case "date":
			e.Date = b.String()
		case "en":
			e.En = b.String()
		case "de":
			e.De = b.String()
		}
	}
	if e.Version == "" || e.De == "" {
		return entry{}, fmt.Errorf("parseEntry: missing required fields (version=%q, de present=%v)", e.Version, e.De != "")
	}
	return e, nil
}

// ── Telegram API ──────────────────────────────────────────────────────────

type tgUser struct {
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
}

type tgChat struct {
	ID    int64  `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

type tgMessage struct {
	Chat tgChat `json:"chat"`
}

type tgUpdate struct {
	UpdateID int64      `json:"update_id"`
	Message  *tgMessage `json:"message"`
}

type tgResponse struct {
	OK          bool            `json:"ok"`
	Description string          `json:"description"`
	Result      json.RawMessage `json:"result"`
}

func tgCall(token, method string, params url.Values, timeout time.Duration, out any) error {
	client := &http.Client{Timeout: timeout}
	endpoint := fmt.Sprintf("%s/bot%s/%s", telegramAPI, token, method)
	resp, err := client.PostForm(endpoint, params)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var r tgResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return fmt.Errorf("decode %s: %w", method, err)
	}
	if !r.OK {
		return fmt.Errorf("telegram %s: %s", method, r.Description)
	}
	if out != nil {
		return json.Unmarshal(r.Result, out)
	}
	return nil
}

func tgGetMe(token string) (*tgUser, error) {
	var u tgUser
	if err := tgCall(token, "getMe", nil, 15*time.Second, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

func tgSendMessage(token string, chatID int64, text string) error {
	params := url.Values{}
	params.Set("chat_id", strconv.FormatInt(chatID, 10))
	params.Set("text", text)
	params.Set("parse_mode", "MarkdownV2")
	params.Set("disable_web_page_preview", "true")
	return tgCall(token, "sendMessage", params, 15*time.Second, nil)
}

func tgGetUpdates(token string, offset int64, longPollSec int) ([]tgUpdate, error) {
	params := url.Values{}
	if offset > 0 {
		params.Set("offset", strconv.FormatInt(offset, 10))
	}
	params.Set("timeout", strconv.Itoa(longPollSec))
	timeout := time.Duration(longPollSec+5) * time.Second
	var updates []tgUpdate
	if err := tgCall(token, "getUpdates", params, timeout, &updates); err != nil {
		return nil, err
	}
	return updates, nil
}

// ── MarkdownV2 rendering ──────────────────────────────────────────────────

// Telegram MarkdownV2 reserves these characters; they MUST be backslash-
// escaped in message text and inside formatting entities.
const mdv2Reserved = "_*[]()~`>#+-=|{}.!"

func escapeMDv2(s string) string {
	var b strings.Builder
	b.Grow(len(s) + len(s)/8)
	for _, r := range s {
		if strings.ContainsRune(mdv2Reserved, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func renderMessage(e entry) string {
	const maxLen = 4096
	header := fmt.Sprintf("🌙 *Noctalum v%s* ist live  \\(%s\\)",
		escapeMDv2(e.Version), escapeMDv2(e.Date))
	body := escapeMDv2(e.De)
	if l := len(header) + 2 + len(body); l > maxLen {
		budget := maxLen - len(header) - 2 - len("\\…")
		if budget < 0 {
			budget = 0
		}
		body = truncateSentence(body, budget) + "\\…"
	}
	return header + "\n\n" + body
}

func truncateSentence(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	// Walk back from `max` to a UTF-8 lead byte so we don't cut mid-rune.
	for max > 0 && (s[max]&0xC0) == 0x80 {
		max--
	}
	cut := s[:max]
	if idx := strings.LastIndexAny(cut, ".!?"); idx > 0 {
		return cut[:idx+1]
	}
	return cut
}

// ── Posting ───────────────────────────────────────────────────────────────

// Per-chat rate limit safety margin between catch-up messages. Telegram's
// documented limit is ~1 msg/sec to the same chat.
const catchUpDelay = 1500 * time.Millisecond

// entriesToPost picks the slice of changelog entries to announce, returned
// in chronological order (oldest first), given the currently-known
// last_posted_version. Empty or unknown last_posted_version falls back to
// the top entry only, to avoid spamming the whole history.
func entriesToPost(entries []entry, lastPosted string, force bool) []entry {
	if len(entries) == 0 {
		return nil
	}
	if force || lastPosted == "" {
		return entries[:1]
	}
	foundAt := -1
	for i, e := range entries {
		if e.Version == lastPosted {
			foundAt = i
			break
		}
	}
	if foundAt == -1 {
		// last_posted_version no longer in the array (entry was edited out,
		// or this is a version from a different branch). Post only the top.
		return entries[:1]
	}
	if foundAt == 0 {
		return nil
	}
	// entries is newest-first; reverse the missing slice to oldest-first.
	missing := make([]entry, foundAt)
	for i := 0; i < foundAt; i++ {
		missing[i] = entries[foundAt-1-i]
	}
	return missing
}

func runPost(changelogPath, pickVer string, dryRun, force bool) error {
	path, err := resolveChangelogPath(changelogPath)
	if err != nil {
		return err
	}
	entries, err := parseChangelog(path)
	if err != nil {
		return err
	}

	// Load config first so we know last_posted_version (used for catch-up
	// selection and dry-run preview alike). A missing config is OK in
	// dry-run; non-dry-run prints a friendly hint and exits 0.
	cfg, cfgErr := loadConfig()
	cfgMissing := errors.Is(cfgErr, os.ErrNotExist)
	if cfgErr != nil && !cfgMissing {
		return cfgErr
	}

	// Pick the entries to post.
	var toPost []entry
	if pickVer != "" {
		for _, e := range entries {
			if e.Version == pickVer {
				toPost = []entry{e}
				break
			}
		}
		if len(toPost) == 0 {
			return fmt.Errorf("--version %s: no matching CHANGELOG entry", pickVer)
		}
	} else {
		lastPosted := ""
		if cfg != nil {
			lastPosted = cfg.LastPostedVersion
		}
		toPost = entriesToPost(entries, lastPosted, force)
		if len(toPost) == 0 {
			fmt.Fprintf(os.Stderr, "skipping: v%s already posted — use --force to repost\n", entries[0].Version)
			return nil
		}
	}

	if dryRun {
		fmt.Printf("--- DRY RUN: %d message(s) ---\n", len(toPost))
		for i, e := range toPost {
			fmt.Printf("\n[%d/%d] v%s — %s\n", i+1, len(toPost), e.Version, e.Date)
			fmt.Println(renderMessage(e))
		}
		fmt.Println("\n--- END ---")
		return nil
	}

	if cfgMissing {
		fmt.Fprintln(os.Stderr, "telegram notifier not configured — run 'noctalum-notify-telegram --setup' to enable")
		return nil
	}

	// Post each entry; update last_posted_version after each successful send
	// so a mid-batch failure resumes cleanly on the next deploy.
	for i, e := range toPost {
		if i > 0 {
			time.Sleep(catchUpDelay)
		}
		if err := tgSendMessage(cfg.BotToken, cfg.ChatID, renderMessage(e)); err != nil {
			return fmt.Errorf("posting v%s: %w", e.Version, err)
		}
		fmt.Fprintf(os.Stderr, "posted v%s to %q (%d)\n", e.Version, cfg.ChatTitle, cfg.ChatID)
		// --version X.Y is a one-off repost; don't move the cursor.
		if pickVer != "" {
			continue
		}
		cfg.LastPostedVersion = e.Version
		if err := saveConfig(cfg); err != nil {
			return fmt.Errorf("save config after v%s: %w", e.Version, err)
		}
	}
	return nil
}

// ── Setup wizard ──────────────────────────────────────────────────────────

func runSetup() error {
	fmt.Println("Noctalum Telegram notifier — setup")
	fmt.Println()

	reader := bufio.NewReader(os.Stdin)

	token, err := promptToken(reader)
	if err != nil {
		return err
	}
	user, err := tgGetMe(token)
	if err != nil {
		return fmt.Errorf("token check failed: %w", err)
	}
	botName := user.Username
	if botName == "" {
		botName = user.FirstName
	}
	fmt.Printf("✓ Token valid — bot is @%s\n\n", botName)

	fmt.Printf("Add @%s to your target Telegram group,\n", botName)
	fmt.Println(`then send any message in the group (e.g. "hi") so the bot sees it.`)
	fmt.Println()
	fmt.Println("Waiting for a group message ... (Ctrl-C to abort)")

	chat, err := waitForGroup(token)
	if err != nil {
		return err
	}
	fmt.Printf("✓ Detected message in group %q (chat_id %d)\n\n", chat.Title, chat.ID)

	fmt.Printf("Use this group? [Y/n] ")
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(strings.ToLower(line))
	if line != "" && line != "y" && line != "yes" {
		return errors.New("user declined the detected group")
	}

	fmt.Println()
	fmt.Println("Sending a test message ...")
	test := "🌙 Telegram\\-Benachrichtigung aktiv — neue Noctalum\\-Versionen werden hier angekündigt\\."
	if err := tgSendMessage(token, chat.ID, test); err != nil {
		return fmt.Errorf("test message failed: %w", err)
	}
	cfg := &config{BotToken: token, ChatID: chat.ID, ChatTitle: chat.Title}
	if err := saveConfig(cfg); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	fmt.Printf("✓ Saved config to %s (mode 0600).\n", configPath())
	fmt.Println("The next ./deploy.sh will announce its changelog here.")
	return nil
}

func promptToken(r *bufio.Reader) (string, error) {
	fmt.Print("Telegram bot token (input hidden, paste then Enter): ")
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		raw, err := term.ReadPassword(fd)
		fmt.Println()
		if err != nil {
			return "", err
		}
		t := strings.TrimSpace(string(raw))
		if t == "" {
			return "", errors.New("empty token")
		}
		return t, nil
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(line)
	if t == "" {
		return "", errors.New("empty token")
	}
	return t, nil
}

func waitForGroup(token string) (*tgChat, error) {
	var offset int64
	for {
		updates, err := tgGetUpdates(token, offset, 25)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  ... getUpdates failed: %v (retrying in 3s)\n", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for _, u := range updates {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			if u.Message == nil {
				continue
			}
			c := u.Message.Chat
			if c.Type == "group" || c.Type == "supergroup" {
				return &c, nil
			}
		}
	}
}
