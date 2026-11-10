package app

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Walkthrough is the tour an agent writes: chapters of stops, each naming the
// hunks it covers. Paths, statistics and code come from the diff, not from it.
type Walkthrough struct {
	Version  int                `json:"version"`
	Title    string             `json:"title"`
	Focus    string             `json:"focus,omitempty"`
	Chapters []WalkthroughPart  `json:"chapters"`
	Support  []WalkthroughAside `json:"support,omitempty"`
}
type WalkthroughPart struct {
	Title string            `json:"title"`
	Stops []WalkthroughStop `json:"stops"`
}
type WalkthroughStop struct {
	Title   string   `json:"title"`
	Summary string   `json:"summary"`
	Prose   string   `json:"prose,omitempty"`
	Hunks   []string `json:"hunks"`
}

// WalkthroughAside groups hunks outside the tour: lockfiles, generated code,
// mechanical edits.
type WalkthroughAside struct {
	Note  string   `json:"note"`
	Hunks []string `json:"hunks"`
}

// The limits codiff's guide sets, which keep a tour shorter than the diff.
const (
	maxChapters     = 6
	maxStops        = 14
	maxHunksPerStop = 14
	maxWalkthrough  = 1024 * 1024
)

// hunk is one "@@" block of a file's patch. Its ID, <path>#<n>, counts from 1
// in the file's patch, as the page's parsePatchFiles does.
type hunk struct {
	ID, Path, Header     string
	N                    int
	Additions, Deletions int
	Lines                []string
	Fingerprint          string
}

// hunks lists the comparison's hunks in the patch's file order.
func (r *Review) hunks() []hunk {
	var result []hunk
	for _, file := range r.Files {
		section := r.sections[file.Path]
		if section == nil {
			continue
		}
		var current *hunk
		for _, line := range strings.Split(section.patch, "\n") {
			if hunkRE.MatchString(line) {
				result = append(result, hunk{Path: file.Path, Header: line, N: current.rank() + 1})
				current = &result[len(result)-1]
				continue
			}
			if current == nil || line == "" {
				continue
			}
			switch line[0] {
			case '+':
				current.Additions++
			case '-':
				current.Deletions++
			case ' ', '\\':
			default:
				continue
			}
			current.Lines = append(current.Lines, line)
		}
	}
	for i := range result {
		h := &result[i]
		h.ID = h.Path + "#" + strconv.Itoa(h.N)
		// The body alone: a hunk added higher in the file moves the header's
		// line numbers, not the change.
		sum := sha1.Sum([]byte(strings.Join(h.Lines, "\n")))
		h.Fingerprint = hex.EncodeToString(sum[:])[:12]
	}
	return result
}

func (h *hunk) rank() int {
	if h == nil {
		return 0
	}
	return h.N
}

// cited lists every hunk ID the document names, stops first, in order.
func (w Walkthrough) cited() []string {
	var ids []string
	for _, chapter := range w.Chapters {
		for _, stop := range chapter.Stops {
			ids = append(ids, stop.Hunks...)
		}
	}
	for _, aside := range w.Support {
		ids = append(ids, aside.Hunks...)
	}
	return ids
}

// validate reports every problem at once, so an agent fixes them in one pass.
func (w Walkthrough) validate(hunks []hunk) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	if len(hunks) == 0 {
		return []string{"this comparison has no hunks to walk through"}
	}
	if w.Version != 1 {
		add("version must be 1")
	}
	if strings.TrimSpace(w.Title) == "" {
		add("title is required")
	}
	if len(w.Chapters) == 0 || len(w.Chapters) > maxChapters {
		add("chapters: %d given, 1 to %d allowed", len(w.Chapters), maxChapters)
	}
	stops := 0
	for i, chapter := range w.Chapters {
		where := fmt.Sprintf("chapters[%d]", i)
		if strings.TrimSpace(chapter.Title) == "" {
			add("%s: title is required", where)
		}
		if len(chapter.Stops) == 0 {
			add("%s: a chapter needs at least one stop", where)
		}
		for j, stop := range chapter.Stops {
			stops++
			where := fmt.Sprintf("%s.stops[%d]", where, j)
			if strings.TrimSpace(stop.Title) == "" {
				add("%s: title is required", where)
			}
			if strings.TrimSpace(stop.Summary) == "" {
				add("%s: summary is required", where)
			}
			if len(stop.Hunks) == 0 || len(stop.Hunks) > maxHunksPerStop {
				add("%s: %d hunks given, 1 to %d allowed", where, len(stop.Hunks), maxHunksPerStop)
			}
		}
	}
	if stops > maxStops {
		add("%d stops given, %d at most", stops, maxStops)
	}
	for i, aside := range w.Support {
		if strings.TrimSpace(aside.Note) == "" {
			add("support[%d]: note is required", i)
		}
		if len(aside.Hunks) == 0 {
			add("support[%d]: a group needs at least one hunk", i)
		}
	}
	known := make(map[string]bool, len(hunks))
	last := map[string]int{}
	for _, h := range hunks {
		known[h.ID] = true
		last[h.Path] = h.N
	}
	seen := map[string]bool{}
	for _, id := range w.cited() {
		switch path, _, _ := cutHunkID(id); {
		case seen[id]:
			add("hunk %q is cited twice; a hunk belongs to one stop or support group", id)
		case known[id]:
		case last[path] > 0:
			add("unknown hunk %q: %s has #1 to #%d", id, path, last[path])
		default:
			add("unknown hunk %q: no hunk in %q; `diffdesk walkthrough hunks` lists them", id, path)
		}
		seen[id] = true
	}
	return problems
}

func cutHunkID(id string) (string, int, bool) {
	i := strings.LastIndexByte(id, '#')
	if i < 0 {
		return id, 0, false
	}
	n, err := strconv.Atoi(id[i+1:])
	return id[:i], n, err == nil && n > 0
}

// storedWalkthrough is the document with what it was written against, so a
// later diff can find its hunks again.
type storedWalkthrough struct {
	Version     int    `json:"version"`
	Branch      string `json:"branch"`
	Range       string `json:"range"`
	WorkingTree bool   `json:"workingTree"`
	Author      string `json:"author"`
	CreatedAt   string `json:"createdAt"`
	// Fingerprints holds each cited hunk's body hash, by the ID it had then.
	Fingerprints map[string]string `json:"fingerprints"`
	Walkthrough  Walkthrough       `json:"walkthrough"`
}

// A branch name may hold slashes: escape it into one file name.
func walkthroughPath(gitDir, branch string) string {
	return filepath.Join(gitDir, "ghl", "walkthroughs", url.PathEscape(branch)+".json")
}

func decodeWalkthrough(input io.Reader) (Walkthrough, error) {
	raw, err := io.ReadAll(io.LimitReader(input, maxWalkthrough+1))
	if err != nil {
		return Walkthrough{}, err
	}
	if len(raw) > maxWalkthrough {
		return Walkthrough{}, fmt.Errorf("walkthrough exceeds %d bytes", maxWalkthrough)
	}
	var w Walkthrough
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	// A misspelt field would otherwise vanish without a word.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&w); err != nil {
		return Walkthrough{}, fmt.Errorf("walkthrough JSON: %w", err)
	}
	return w, nil
}

func readWalkthrough(path string) (*storedWalkthrough, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var stored storedWalkthrough
	if err := json.Unmarshal(raw, &stored); err != nil || stored.Version != 1 {
		return nil, fmt.Errorf("%s is not a walkthrough this version can read", path)
	}
	return &stored, nil
}

// writeWalkthrough replaces the file whole, so a reader never sees half of it.
func writeWalkthrough(path string, stored storedWalkthrough) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), "walkthrough-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// locate maps each ID the document cites to a hunk of the current diff, or to
// nil when it is gone. A fingerprint finds a hunk that moved; failing that, the
// hunk at the same rank counts when no cited hunk claims its content, which
// keeps a stop on a hunk edited since.
func (s storedWalkthrough) locate(hunks []hunk) map[string]*hunk {
	byPath := map[string][]*hunk{}
	for i := range hunks {
		byPath[hunks[i].Path] = append(byPath[hunks[i].Path], &hunks[i])
	}
	cited := map[string]bool{}
	for _, fingerprint := range s.Fingerprints {
		cited[fingerprint] = true
	}
	claimed := map[*hunk]bool{}
	found := map[string]*hunk{}
	ids := s.Walkthrough.cited()
	for _, id := range ids {
		path, n, _ := cutHunkID(id)
		var match *hunk
		for _, h := range byPath[path] {
			if h.Fingerprint == s.Fingerprints[id] && !claimed[h] && (match == nil || h.N == n) {
				match = h
			}
		}
		if match != nil {
			found[id], claimed[match] = match, true
		}
	}
	for _, id := range ids {
		if found[id] != nil {
			continue
		}
		path, n, _ := cutHunkID(id)
		found[id] = nil
		if candidates := byPath[path]; n >= 1 && n <= len(candidates) {
			if h := candidates[n-1]; !claimed[h] && !cited[h.Fingerprint] {
				found[id], claimed[h] = h, true
			}
		}
	}
	return found
}

// stale reports a walkthrough of which half the hunks are gone: better
// regenerated than read.
func stale(found map[string]*hunk) bool {
	missing := 0
	for _, h := range found {
		if h == nil {
			missing++
		}
	}
	return missing > 0 && 2*missing >= len(found)
}
