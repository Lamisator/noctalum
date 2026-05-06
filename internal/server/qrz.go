package server

import (
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// QRZResult holds the data returned from a QRZ.com callsign lookup.
type QRZResult struct {
	Name    string `json:"name"`
	Locator string `json:"locator"`
	HasPic  bool   `json:"has_picture"`
}

type cachedPic struct {
	url     string
	expires time.Time
}

// QRZClient authenticates with QRZ.com and performs callsign lookups.
type QRZClient struct {
	username    string
	password    string
	mu          sync.Mutex
	sessionKey  string
	pictureURLs map[string]cachedPic
	httpClient  *http.Client
}

func NewQRZClient(username, password string) *QRZClient {
	return &QRZClient{
		username:    username,
		password:    password,
		pictureURLs: make(map[string]cachedPic),
		httpClient:  &http.Client{Timeout: 10 * time.Second},
	}
}

// Lookup returns name, locator and picture availability for a callsign.
func (c *QRZClient) Lookup(callsign string) (*QRZResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.sessionKey == "" {
		if err := c.authenticate(); err != nil {
			return nil, err
		}
	}

	result, err := c.doLookup(callsign)
	if err != nil && isSessionError(err) {
		c.sessionKey = ""
		if err2 := c.authenticate(); err2 != nil {
			return nil, err2
		}
		result, err = c.doLookup(callsign)
	}
	return result, err
}

// PictureURL returns the cached QRZ picture URL for a callsign (empty if none).
func (c *QRZClient) PictureURL(callsign string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pictureURLs[strings.ToUpper(callsign)]
	if !ok || time.Now().After(p.expires) {
		return ""
	}
	return p.url
}

func (c *QRZClient) authenticate() error {
	reqURL := fmt.Sprintf("https://xmldata.qrz.com/xml/current/?username=%s;password=%s;agent=ContestLog",
		url.QueryEscape(c.username), url.QueryEscape(c.password))
	resp, err := c.httpClient.Get(reqURL)
	if err != nil {
		return fmt.Errorf("qrz auth: %w", err)
	}
	defer resp.Body.Close()

	var db qrzDatabase
	if err := xml.NewDecoder(resp.Body).Decode(&db); err != nil {
		return fmt.Errorf("qrz auth decode: %w", err)
	}
	if db.Session.Error != "" {
		return fmt.Errorf("qrz: %s", db.Session.Error)
	}
	c.sessionKey = db.Session.Key
	return nil
}

func (c *QRZClient) doLookup(callsign string) (*QRZResult, error) {
	reqURL := fmt.Sprintf("https://xmldata.qrz.com/xml/current/?s=%s;callsign=%s",
		url.QueryEscape(c.sessionKey), url.QueryEscape(strings.ToUpper(callsign)))
	resp, err := c.httpClient.Get(reqURL)
	if err != nil {
		return nil, fmt.Errorf("qrz lookup: %w", err)
	}
	defer resp.Body.Close()

	var db qrzDatabase
	if err := xml.NewDecoder(resp.Body).Decode(&db); err != nil {
		return nil, fmt.Errorf("qrz decode: %w", err)
	}
	if db.Session.Error != "" {
		return nil, fmt.Errorf("qrz: %s", db.Session.Error)
	}

	parts := []string{}
	if db.Callsign.FName != "" {
		parts = append(parts, db.Callsign.FName)
	}
	if db.Callsign.Name != "" {
		parts = append(parts, db.Callsign.Name)
	}
	name := strings.Join(parts, " ")

	result := &QRZResult{
		Name:    name,
		Locator: db.Callsign.Grid,
		HasPic:  db.Callsign.Image != "",
	}
	if db.Callsign.Image != "" {
		c.pictureURLs[strings.ToUpper(callsign)] = cachedPic{
			url:     db.Callsign.Image,
			expires: time.Now().Add(time.Hour),
		}
	}
	return result, nil
}

func isSessionError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Session Timeout") ||
		strings.Contains(msg, "Invalid session") ||
		strings.Contains(msg, "session")
}

// QRZ XML structures
type qrzDatabase struct {
	XMLName  xml.Name    `xml:"QRZDatabase"`
	Session  qrzSession  `xml:"Session"`
	Callsign qrzCallsign `xml:"Callsign"`
}

type qrzSession struct {
	Key   string `xml:"Key"`
	Error string `xml:"Error"`
}

type qrzCallsign struct {
	Call  string `xml:"call"`
	FName string `xml:"fname"`
	Name  string `xml:"name"`
	Grid  string `xml:"grid"`
	Image string `xml:"image"`
}
