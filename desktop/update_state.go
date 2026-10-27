package main

import "sync"

// A revision lets a reloaded page subscribe before reading without replacing
// a newer event with the older reply. Installation targets never come from JS.
type updateSnapshot struct {
	Revision uint64 `json:"revision"`
	Status   string `json:"status"`
	Version  string `json:"version"`
	Manager  string `json:"manager"`
	Notes    string `json:"notes"`
	Message  string `json:"message"`
	Retry    string `json:"retry"`
}

type updateSession struct {
	mu           sync.Mutex
	state        updateSnapshot
	busy         bool
	installation updateInstallation
}

func (s *updateSession) snapshot() updateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.state
	if state.Status == "" {
		state.Status = "idle"
	}
	return state
}

func (s *updateSession) startCheck(manual bool) (updateSnapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy {
		return s.state, false
	}
	s.busy = true
	s.installation = updateInstallation{}
	status := "idle"
	if manual {
		status = "checking"
	}
	s.state = updateSnapshot{Revision: s.state.Revision + 1, Status: status}
	return s.state, true
}

func (s *updateSession) checked(installation updateInstallation, current string, offered updateRelease, err error, retry string, manual bool) updateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.busy = false
	s.state = updateSnapshot{Revision: s.state.Revision + 1, Status: "idle"}
	switch {
	case err != nil:
		if manual {
			s.state.Status, s.state.Message, s.state.Retry = "error", err.Error(), retry
		}
	case offered.Version != "":
		s.installation = installation
		s.state.Status, s.state.Version, s.state.Manager = "available", offered.Version, installation.manager
		s.state.Notes = offered.Notes
	case manual:
		s.state.Status, s.state.Version = "current", current
	}
	return s.state
}

func (s *updateSession) startInstall() (updateSnapshot, updateInstallation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy || s.installation.manager == "" || (s.state.Status != "available" && s.state.Retry != "install") {
		return s.state, updateInstallation{}, false
	}
	s.busy = true
	s.state.Revision++
	s.state.Status, s.state.Message, s.state.Retry = "installing", "", ""
	return s.state, s.installation, true
}

func (s *updateSession) installFailed(message string, retry bool) updateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.busy = false
	s.state.Revision++
	s.state.Status, s.state.Message, s.state.Retry = "error", message, ""
	if retry {
		s.state.Retry = "install"
	}
	return s.state
}

func (s *updateSession) restarting() updateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Revision++
	s.state.Status = "restarting"
	return s.state
}

func (s *updateSession) dismiss() updateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.busy {
		s.state = updateSnapshot{Revision: s.state.Revision + 1, Status: "idle"}
		s.installation = updateInstallation{}
	}
	return s.state
}
