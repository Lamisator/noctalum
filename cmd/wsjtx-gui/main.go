// noctalum-wsjtx-gui is the cross-platform desktop bridge that forwards
// WSJT-X LOG_QSO datagrams into a Noctalum server.  It supports both
// authentication flows the server offers:
//
//   - Token mode: paste the copy-pasteable "noc1.…" blob from the
//     Noctalum web UI.  No username, no password, no contest picker —
//     the token carries all three.
//   - Password mode: classic login + interactive contest picker.
//
// The GUI is built with Fyne so we ship one static binary per OS and
// don't inherit the Qt-TLS-plugin / OpenSSL-DLL bundling pain the old
// Qt version had.  Go's stdlib HTTPS Just Works.
package main

import (
	"fmt"
	"strings"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	"image/color"
)

const (
	appTitle   = "Noctalum · WSJT-X Bridge"
	appVersion = "0.76"
)

// ui bundles every widget the state machine needs to poke.  A pointer to
// ui is shared between the goroutine that drains the session's event
// channel and the click handlers on the buttons.  Fyne widget updates are
// safe to call from any goroutine.
type ui struct {
	win fyne.Window
	sess *session

	// Auth mode
	authRadio *widget.RadioGroup

	// Token-mode inputs
	tokenEntry       *widget.Entry
	rememberTokenCB  *widget.Check
	tokenStartBtn    *widget.Button
	tokenStopBtn     *widget.Button

	// Password-mode inputs
	serverEntry     *widget.Entry
	userEntry       *widget.Entry
	passEntry       *widget.Entry
	rememberPassCB  *widget.Check
	loginBtn        *widget.Button
	logoutBtn       *widget.Button
	contestSelect   *widget.Select
	contestCard     *fyne.Container
	pwdStartBtn     *widget.Button
	pwdStopBtn      *widget.Button
	contests        []contest

	// Shared
	udpEntry        *widget.Entry
	forceDupCB      *widget.Check
	forgetBtn       *widget.Button

	// Body swap
	authStack       *fyne.Container
	tokenPage       fyne.CanvasObject
	pwdPage         fyne.CanvasObject

	// Status + log
	statusLbl  *widget.Label
	qsoCount   int
	pendingCnt int
	countLbl   *widget.Label
	logEntries []logRow
	logList    *widget.List
}

// logRow is one entry in the activity log.  We store the pre-formatted
// display string and a colour hint so widget.List updates stay cheap
// (no per-scroll formatting work).
type logRow struct {
	Text  string
	Tone  string // "", "ok", "warn", "err"
}

func main() {
	a := app.New()
	a.Settings().SetTheme(theme.DarkTheme())
	w := a.NewWindow(appTitle)
	w.Resize(fyne.NewSize(720, 720))

	u := &ui{
		win:  w,
		sess: newSession(),
	}
	u.build()
	u.loadFromCredentials(loadCredentials())

	// Drain session events on a background goroutine and marshal each
	// one into a UI mutation.  Fyne widgets are goroutine-safe, so this
	// works without any additional dispatcher.
	go u.pumpEvents()

	u.appendLog("Ready. Paste a bridge token or switch to username/password to begin.", "")
	u.setStage(stageIdle)

	w.ShowAndRun()
}

// ── State machine ────────────────────────────────────────────────────────
//
// The stages here match the Qt version so behaviour stays predictable:
//   idle             — no auth done, no listener bound
//   signedIn         — password login accepted, contest picker populated
//   listeningPwd     — password mode + UDP socket bound
//   listeningToken   — token mode + UDP socket bound
type stage int

const (
	stageIdle stage = iota
	stageSignedIn
	stageListeningPwd
	stageListeningToken
)

func (u *ui) setStage(s stage) {
	listening := s == stageListeningPwd || s == stageListeningToken
	tokenMode := u.authRadio.Selected == "Bridge token (one click)"

	// Auth-mode toggle locks during any active state so mode-switching
	// mid-session can't leave the session half-configured.
	if listening || s == stageSignedIn {
		u.authRadio.Disable()
	} else {
		u.authRadio.Enable()
	}

	// Token-page buttons
	u.tokenStartBtn.Enable()
	u.tokenStopBtn.Disable()
	if s == stageListeningToken {
		u.tokenStartBtn.Disable()
		u.tokenStopBtn.Enable()
	}
	if listening {
		u.tokenEntry.Disable()
		u.rememberTokenCB.Disable()
	} else {
		u.tokenEntry.Enable()
		u.rememberTokenCB.Enable()
	}

	// Password-page buttons
	if s == stageIdle && !tokenMode {
		u.loginBtn.Enable()
	} else {
		u.loginBtn.Disable()
	}
	if s == stageSignedIn {
		u.logoutBtn.Enable()
	} else {
		u.logoutBtn.Disable()
	}
	u.pwdStartBtn.Disable()
	u.pwdStopBtn.Disable()
	if s == stageSignedIn && len(u.contests) > 0 {
		u.pwdStartBtn.Enable()
	}
	if s == stageListeningPwd {
		u.pwdStopBtn.Enable()
	}
	if s == stageIdle {
		u.serverEntry.Enable()
		u.userEntry.Enable()
		u.passEntry.Enable()
		u.rememberPassCB.Enable()
		u.contestSelect.Disable()
	} else if s == stageSignedIn {
		u.serverEntry.Disable()
		u.userEntry.Disable()
		u.passEntry.Disable()
		u.rememberPassCB.Disable()
		u.contestSelect.Enable()
	} else {
		u.serverEntry.Disable()
		u.userEntry.Disable()
		u.passEntry.Disable()
		u.contestSelect.Disable()
	}

	// Shared
	if listening {
		u.udpEntry.Disable()
		u.forceDupCB.Disable()
	} else {
		u.udpEntry.Enable()
		u.forceDupCB.Enable()
	}

	// Contest card is a password-mode-only thing.
	u.contestCard.Hidden = tokenMode
	u.contestCard.Refresh()

	// Status pill
	switch {
	case s == stageListeningToken:
		if id, call := u.sess.TokenContestInfo(); call != "" {
			u.statusLbl.SetText(fmt.Sprintf("Listening · %s (contest #%d)", call, id))
		} else {
			u.statusLbl.SetText("Listening")
		}
	case s == stageListeningPwd:
		if u.contestSelect.Selected != "" {
			u.statusLbl.SetText("Listening · " + u.contestSelect.Selected)
		} else {
			u.statusLbl.SetText("Listening")
		}
	case s == stageSignedIn:
		u.statusLbl.SetText("Signed in as " + u.userEntry.Text)
	default:
		u.statusLbl.SetText("Offline")
	}
}

// ── UI construction ──────────────────────────────────────────────────────

func (u *ui) build() {
	// ── Auth mode radio ──
	u.authRadio = widget.NewRadioGroup(
		[]string{"Bridge token (one click)", "Username & password"},
		func(_ string) { u.onAuthModeChanged() },
	)
	u.authRadio.Horizontal = true
	u.authRadio.SetSelected("Bridge token (one click)")

	// ── Shared fields (used in both modes) ──
	u.udpEntry = widget.NewEntry()
	u.udpEntry.SetText("0.0.0.0:2237")
	u.udpEntry.SetPlaceHolder("0.0.0.0:2237")
	u.forceDupCB = widget.NewCheck("Log duplicates (send QSOs even when the server flags them)", nil)

	u.forgetBtn = widget.NewButton("Forget saved credentials", u.onForgetClicked)

	// ── Token-mode page ──
	u.tokenEntry = widget.NewPasswordEntry()
	u.tokenEntry.SetPlaceHolder("noc1.…")
	u.rememberTokenCB = widget.NewCheck("Remember token on this device", nil)
	u.tokenStartBtn = widget.NewButton("Start bridge", u.onTokenStartClicked)
	u.tokenStartBtn.Importance = widget.HighImportance
	u.tokenStopBtn = widget.NewButton("Stop", u.onStopClicked)

	u.tokenPage = container.NewVBox(
		widget.NewLabelWithStyle(
			"Paste the token you copied from Noctalum → contest picker → \"WSJT-X bridge token\". "+
				"It packs the server URL, your helper token, and the contest to log into.",
			fyne.TextAlignLeading, fyne.TextStyle{Italic: true}),
		labeledRow("Bridge token", u.tokenEntry),
		labeledRow("WSJT-X UDP",   u.udpEntry),
		u.rememberTokenCB,
		u.forceDupCB,
		container.NewHBox(layout.NewSpacer(), u.tokenStopBtn, u.tokenStartBtn),
	)

	// ── Password-mode page ──
	u.serverEntry = widget.NewEntry()
	u.serverEntry.SetPlaceHolder("https://log.example.org")
	u.userEntry = widget.NewEntry()
	u.userEntry.SetPlaceHolder("callsign or username")
	u.passEntry = widget.NewPasswordEntry()
	u.rememberPassCB = widget.NewCheck("Remember credentials on this device", nil)
	u.loginBtn = widget.NewButton("Log in", u.onLoginClicked)
	u.loginBtn.Importance = widget.HighImportance
	u.logoutBtn = widget.NewButton("Log out", u.onLogoutClicked)

	u.pwdPage = container.NewVBox(
		labeledRow("Server URL", u.serverEntry),
		labeledRow("Username",   u.userEntry),
		labeledRow("Password",   u.passEntry),
		labeledRow("WSJT-X UDP", u.udpEntry),
		u.rememberPassCB,
		u.forceDupCB,
		container.NewHBox(layout.NewSpacer(), u.logoutBtn, u.loginBtn),
	)

	u.authStack = container.NewMax(u.tokenPage) // starts on token page
	authCard := widget.NewCard("Connection", "", container.NewVBox(
		u.authRadio,
		u.authStack,
		container.NewHBox(u.forgetBtn, layout.NewSpacer()),
	))

	// ── Contest picker card (password mode only) ──
	u.contestSelect = widget.NewSelect(nil, func(_ string) {})
	u.pwdStartBtn = widget.NewButton("Start bridge", u.onPwdStartClicked)
	u.pwdStartBtn.Importance = widget.HighImportance
	u.pwdStopBtn = widget.NewButton("Stop", u.onStopClicked)
	u.contestCard = container.NewVBox(
		widget.NewCard("Contest", "",
			container.NewVBox(
				widget.NewLabelWithStyle(
					"Pick the contest that receives every QSO WSJT-X reports on the UDP port above.",
					fyne.TextAlignLeading, fyne.TextStyle{Italic: true}),
				u.contestSelect,
				container.NewHBox(layout.NewSpacer(), u.pwdStopBtn, u.pwdStartBtn),
			),
		),
	)

	// ── Status pill + activity log ──
	u.statusLbl = widget.NewLabel("Offline")
	u.qsoCount = 0
	u.countLbl = widget.NewLabel("0 QSOs logged")

	u.logList = widget.NewList(
		func() int { return len(u.logEntries) },
		func() fyne.CanvasObject { return canvas.NewText("", color.White) },
		func(i widget.ListItemID, o fyne.CanvasObject) {
			row := u.logEntries[i]
			t := o.(*canvas.Text)
			t.Text = row.Text
			t.Color = toneColor(row.Tone)
			t.TextSize = 12
			t.Refresh()
		},
	)
	clearBtn := widget.NewButton("Clear", func() {
		u.logEntries = nil
		u.qsoCount = 0
		u.refreshCountLabel()
		u.logList.Refresh()
	})
	activityHead := container.NewBorder(nil, nil,
		u.countLbl, clearBtn, nil,
	)
	activityCard := widget.NewCard("Activity", "",
		container.NewBorder(activityHead, nil, nil, nil, u.logList),
	)

	// ── Root layout ──
	header := container.NewHBox(
		widget.NewLabelWithStyle("Noctalum · WSJT-X Bridge",
			fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		layout.NewSpacer(),
		u.statusLbl,
	)

	root := container.NewBorder(
		container.NewVBox(header, authCard, u.contestCard),
		nil, nil, nil,
		activityCard,
	)
	u.win.SetContent(root)
}

// labeledRow lays out a left-aligned label + widget on the same row —
// mirrors Fyne's QFormLayout when you don't need the vertical grid.
func labeledRow(label string, w fyne.CanvasObject) fyne.CanvasObject {
	l := widget.NewLabel(label)
	l.Alignment = fyne.TextAlignTrailing
	return container.NewBorder(nil, nil, l, nil, w)
}

func toneColor(tone string) color.Color {
	switch tone {
	case "ok":
		return color.NRGBA{R: 0x66, G: 0xbb, B: 0x6a, A: 0xff}
	case "warn":
		return color.NRGBA{R: 0xff, G: 0xb7, B: 0x4d, A: 0xff}
	case "err":
		return color.NRGBA{R: 0xef, G: 0x53, B: 0x50, A: 0xff}
	default:
		return color.NRGBA{R: 0xe6, G: 0xea, B: 0xf0, A: 0xff}
	}
}

// ── Actions ──────────────────────────────────────────────────────────────

func (u *ui) onAuthModeChanged() {
	if u.authRadio.Selected == "Bridge token (one click)" {
		u.authStack.Objects = []fyne.CanvasObject{u.tokenPage}
	} else {
		u.authStack.Objects = []fyne.CanvasObject{u.pwdPage}
	}
	u.authStack.Refresh()
	// Fresh state whenever the operator switches modes at rest.
	if !u.sess.Listening() {
		u.sess.Reset()
		u.contests = nil
		u.contestSelect.Options = nil
		u.contestSelect.SetSelected("")
		u.setStage(stageIdle)
	} else {
		u.setStage(u.currentStage())
	}
}

func (u *ui) currentStage() stage {
	if u.sess.Listening() {
		if u.authRadio.Selected == "Bridge token (one click)" {
			return stageListeningToken
		}
		return stageListeningPwd
	}
	return stageIdle
}

func (u *ui) onLoginClicked() {
	server := strings.TrimSpace(u.serverEntry.Text)
	user := strings.TrimSpace(u.userEntry.Text)
	pass := u.passEntry.Text
	if server == "" || user == "" || pass == "" {
		dialog.ShowInformation("Log in", "Server URL, username, and password are all required.", u.win)
		return
	}
	u.loginBtn.Disable()
	u.appendLog(fmt.Sprintf("Signing in to %s…", server), "")
	go func() {
		if err := u.sess.Login(server, user, pass); err != nil {
			u.appendLog("Error: "+err.Error(), "err")
			u.loginBtn.Enable()
			return
		}
		u.appendLog("Signed in. Fetching contests…", "ok")
		u.saveCurrentCredentials("password")
		contests, err := u.sess.FetchContests()
		if err != nil {
			u.appendLog("Error: "+err.Error(), "err")
			u.loginBtn.Enable()
			return
		}
		u.contests = contests
		options := make([]string, 0, len(contests))
		for _, c := range contests {
			label := fmt.Sprintf("%s · %s · %s", c.Name, c.StationCall, c.Status)
			options = append(options, label)
		}
		u.contestSelect.Options = options
		if len(options) > 0 {
			u.contestSelect.SetSelected(options[0])
		}
		u.contestSelect.Refresh()
		if len(contests) == 0 {
			u.appendLog("Server returned no contests. Create one in the web UI first.", "warn")
		} else {
			u.appendLog(fmt.Sprintf("Loaded %d contest(s).", len(contests)), "")
		}
		u.setStage(stageSignedIn)
	}()
}

func (u *ui) onLogoutClicked() {
	u.sess.Reset()
	u.contests = nil
	u.contestSelect.Options = nil
	u.contestSelect.SetSelected("")
	u.appendLog("Signed out.", "")
	u.setStage(stageIdle)
}

func (u *ui) onPwdStartClicked() {
	idx := indexOfString(u.contestSelect.Options, u.contestSelect.Selected)
	if idx < 0 || idx >= len(u.contests) {
		dialog.ShowInformation("Start bridge", "Pick a contest first.", u.win)
		return
	}
	c := u.contests[idx]
	u.pwdStartBtn.Disable()
	u.appendLog(fmt.Sprintf("Selecting contest \"%s\"…", c.Name), "")
	go func() {
		if err := u.sess.SelectContest(c.ID); err != nil {
			u.appendLog("Error: "+err.Error(), "err")
			u.pwdStartBtn.Enable()
			return
		}
		udp := strings.TrimSpace(u.udpEntry.Text)
		if udp == "" {
			udp = "0.0.0.0:2237"
		}
		if err := u.sess.StartListening(udp, u.forceDupCB.Checked); err != nil {
			u.appendLog("Error: "+err.Error(), "err")
			u.pwdStartBtn.Enable()
			return
		}
		u.setStage(stageListeningPwd)
	}()
}

func (u *ui) onTokenStartClicked() {
	blob := strings.TrimSpace(u.tokenEntry.Text)
	if blob == "" {
		dialog.ShowInformation("Start bridge", "Paste the bridge token from Noctalum first.", u.win)
		return
	}
	if err := u.sess.ConfigureToken(blob); err != nil {
		u.appendLog("Error: "+err.Error(), "err")
		return
	}
	udp := strings.TrimSpace(u.udpEntry.Text)
	if udp == "" {
		udp = "0.0.0.0:2237"
	}
	if err := u.sess.StartListening(udp, u.forceDupCB.Checked); err != nil {
		u.appendLog("Error: "+err.Error(), "err")
		return
	}
	u.saveCurrentCredentials("token")
	u.appendLog("Bridge token accepted — listening.", "ok")
	u.setStage(stageListeningToken)
}

func (u *ui) onStopClicked() {
	u.sess.Stop()
	u.appendLog("Stopped listening.", "")
	if u.authRadio.Selected == "Bridge token (one click)" {
		u.sess.Reset()
		u.setStage(stageIdle)
	} else {
		u.setStage(stageSignedIn)
	}
}

func (u *ui) onForgetClicked() {
	dialog.ShowConfirm("Forget credentials",
		"Delete saved credentials from this device?\n\nPath: "+credentialsPath(),
		func(ok bool) {
			if !ok {
				return
			}
			_ = clearCredentials()
			u.passEntry.SetText("")
			u.tokenEntry.SetText("")
			u.rememberPassCB.SetChecked(false)
			u.rememberTokenCB.SetChecked(false)
			u.appendLog("Saved credentials removed.", "")
		}, u.win)
}

// ── Event pump ───────────────────────────────────────────────────────────

func (u *ui) pumpEvents() {
	// Pick up whatever's already queued from a previous run so the
	// "N pending" label is accurate before the first event fires.
	u.pendingCnt = u.sess.OutboxLen()
	u.refreshCountLabel()
	if u.pendingCnt > 0 {
		u.appendLog(fmt.Sprintf(
			"Loaded %d QSO(s) from a previous session's outbox — will retry as soon as the server is reachable.",
			u.pendingCnt), "warn")
	}
	for e := range u.sess.Events() {
		switch e.Kind {
		case "listening":
			u.appendLog("Listening on "+e.Message+" for WSJT-X.", "ok")
		case "stopped":
			// The listener can stop on its own (socket error) as well
			// as via the Stop button; ignore the event if the button
			// already reset state.
			if u.sess.Listening() {
				continue
			}
		case "log":
			u.appendLog(e.Message, "warn")
		case "queue":
			u.pendingCnt = e.Pending
			u.refreshCountLabel()
		case "qso":
			r := e.Result
			if r == nil || r.Item == nil {
				continue
			}
			u.appendQSOLine(r)
		case "error":
			u.appendLog("Error: "+e.Message, "err")
		}
	}
}

// appendQSOLine turns a qsoResult into the one-line Activity log entry
// the operator sees.  Each result kind maps to a distinct prefix so an
// outage's retry chatter stays visually distinct from confirmed sends.
func (u *ui) appendQSOLine(r *qsoResult) {
	it := r.Item
	// Pretty-print the QSO on a fixed grid so consecutive log lines
	// line up regardless of callsign length.
	line := fmt.Sprintf("%-12s  %-6s", it.Callsign, it.Mode)
	switch r.Kind {
	case qsoQueued:
		u.appendLog(line+"  → queued", "")
	case qsoSent:
		u.qsoCount++
		u.refreshCountLabel()
		u.appendLog(line+"  ✓ sent to server", "ok")
	case qsoSkipped:
		u.appendLog(line+"  — "+r.Err, "warn")
	case qsoDropped:
		u.appendLog(line+"  ✗ dropped: "+r.Err, "err")
	case qsoRetry:
		// Retry noise is high during an outage; downgrade to warn
		// (yellow) and lean on the "N pending" counter for state.
		u.appendLog(line+"  … waiting to retry: "+r.Err, "warn")
	}
}

// refreshCountLabel rebuilds the "N logged / M pending" text.  The
// pending part only shows when there's actually something waiting so an
// idle bridge doesn't nag with "0 pending".
func (u *ui) refreshCountLabel() {
	if u.pendingCnt > 0 {
		u.countLbl.SetText(fmt.Sprintf("%d QSOs logged · %d pending", u.qsoCount, u.pendingCnt))
	} else {
		u.countLbl.SetText(fmt.Sprintf("%d QSOs logged", u.qsoCount))
	}
}

// ── Log helpers ──────────────────────────────────────────────────────────

func (u *ui) appendLog(msg, tone string) {
	line := fmt.Sprintf("[%s]  %s", time.Now().Format("15:04:05"), msg)
	u.logEntries = append(u.logEntries, logRow{Text: line, Tone: tone})
	// Bound the log so a multi-hour session doesn't consume all RAM.
	if len(u.logEntries) > 2000 {
		u.logEntries = u.logEntries[len(u.logEntries)-2000:]
	}
	u.logList.Refresh()
	u.logList.ScrollToBottom()
}

// ── Credentials integration ──────────────────────────────────────────────

func (u *ui) loadFromCredentials(c credentials) {
	if c.Server != "" {
		u.serverEntry.SetText(c.Server)
	}
	if c.User != "" {
		u.userEntry.SetText(c.User)
	}
	if c.UDP != "" {
		u.udpEntry.SetText(c.UDP)
	}
	if c.RememberPass {
		u.passEntry.SetText(c.Pass)
	}
	if c.RememberToken {
		u.tokenEntry.SetText(c.Token)
	}
	u.rememberPassCB.SetChecked(c.RememberPass)
	u.rememberTokenCB.SetChecked(c.RememberToken)
	u.forceDupCB.SetChecked(c.ForceDup)

	// Restore the auth mode.  New installs → token.  Legacy configs
	// without auth_mode → password only if they carried a remembered
	// password.
	mode := "Bridge token (one click)"
	switch c.AuthMode {
	case "password":
		mode = "Username & password"
	case "token":
		mode = "Bridge token (one click)"
	default:
		if c.RememberPass && c.Pass != "" {
			mode = "Username & password"
		}
	}
	u.authRadio.SetSelected(mode)

	if mode == "Bridge token (one click)" && c.RememberToken && c.Token != "" {
		u.appendLog("Loaded saved token — press Start bridge to connect.", "")
	} else if mode == "Username & password" && c.RememberPass && c.Pass != "" {
		u.appendLog("Loaded saved credentials — press Log in to continue.", "")
	}
}

func (u *ui) saveCurrentCredentials(mode string) {
	c := credentials{
		Server:        strings.TrimSpace(u.serverEntry.Text),
		User:          strings.TrimSpace(u.userEntry.Text),
		Pass:          u.passEntry.Text,
		UDP:           strings.TrimSpace(u.udpEntry.Text),
		RememberPass:  u.rememberPassCB.Checked,
		ForceDup:      u.forceDupCB.Checked,
		AuthMode:      mode,
		Token:         strings.TrimSpace(u.tokenEntry.Text),
		RememberToken: u.rememberTokenCB.Checked,
	}
	if err := saveCredentials(c); err != nil {
		u.appendLog("Warning: could not save credentials — "+err.Error(), "warn")
	}
}

// ── Small helpers ────────────────────────────────────────────────────────

func indexOfString(haystack []string, needle string) int {
	for i, s := range haystack {
		if s == needle {
			return i
		}
	}
	return -1
}
