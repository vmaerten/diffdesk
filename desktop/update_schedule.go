package main

import (
	"os"
	"strings"
	"sync"
	"time"
)

const (
	// A running app checks again each day from this hour, local time.
	dailyUpdateHour = 10
	// After a check that could not reach GitHub, such as one made on wake
	// before the network is back.
	updateRetryDelay = 15 * time.Minute
)

// updateSchedule decides when a running app checks for updates again. It reads
// the wall clock only: on macOS the monotonic clock stops while the Mac sleeps.
type updateSchedule struct {
	mu sync.Mutex
	// When the last check started, and when the last one that need not be retried did.
	attempted, settled time.Time
}

func (s *updateSchedule) started(at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempted = at.Round(0)
}

func (s *updateSchedule) finished(started time.Time, retry bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !retry {
		s.settled = started.Round(0)
	}
}

func (s *updateSchedule) due(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now = now.Round(0)
	return s.settled.Before(latestDailySlot(now)) && now.Sub(s.attempted) >= updateRetryDelay
}

// latestDailySlot is the last 10:00 at or before now, in now's time zone.
func latestDailySlot(now time.Time) time.Time {
	slot := time.Date(now.Year(), now.Month(), now.Day(), dailyUpdateHour, 0, 0, 0, now.Location())
	if slot.After(now) {
		slot = slot.AddDate(0, 0, -1)
	}
	return slot
}

// systemZone follows a time zone change made while the app runs, which
// time.Local, read once at startup, misses.
func systemZone() *time.Location {
	target, err := os.Readlink("/etc/localtime")
	if _, name, ok := strings.Cut(target, "zoneinfo/"); err == nil && ok {
		if zone, err := time.LoadLocation(name); err == nil {
			return zone
		}
	}
	return time.Local
}
