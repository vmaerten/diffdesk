package app

type Comparison struct {
	Before string  `json:"before"`
	After  *string `json:"after"`
}
type BaseResolution struct {
	Ref      string      `json:"ref"`
	Source   string      `json:"source"`
	Branch   *string     `json:"branch"`
	Trunk    *string     `json:"trunk"`
	Stack    *StackChain `json:"stack"`
	Distance *int        `json:"distance,omitempty"`
}
type StackPR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}
type StackLayer struct {
	Branch string   `json:"branch"`
	Base   string   `json:"base"`
	PR     *StackPR `json:"pr"`
	Merged bool     `json:"merged"`
	Exists bool     `json:"exists"`
}
type StackChain struct {
	Trunk   string       `json:"trunk"`
	Layers  []StackLayer `json:"layers"`
	Current int          `json:"current"`
}
type RefDetail struct {
	Name string `json:"name"`
	When string `json:"when"`
}
type CommitDetail struct {
	SHA       string   `json:"sha"`
	Short     string   `json:"short"`
	Subject   string   `json:"subject"`
	Author    string   `json:"author"`
	When      string   `json:"when"`
	Parents   []string `json:"parents"`
	Additions *int     `json:"additions"`
	Deletions *int     `json:"deletions"`
	Files     *int     `json:"files"`
}
type FileStat struct {
	Path      string  `json:"path"`
	Additions int     `json:"additions"`
	Deletions int     `json:"deletions"`
	Binary    bool    `json:"binary"`
	Status    string  `json:"status"`
	Hash      *string `json:"hash"`
}
type Totals struct {
	Files     int `json:"files"`
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
}
type Comment struct {
	ID        string   `json:"id"`
	Path      string   `json:"path"`
	Side      string   `json:"side"`
	Start     int      `json:"start"`
	End       int      `json:"end"`
	Body      string   `json:"body"`
	Anchor    []string `json:"anchor"`
	Range     string   `json:"range"`
	CreatedAt string   `json:"createdAt"`
}
type ServedComment struct {
	Comment
	Stale bool     `json:"stale"`
	Code  []string `json:"code"`
}
type ViewedMap map[string]*string
type StoredState struct {
	Version  int                  `json:"version"`
	Viewed   map[string]ViewedMap `json:"viewed"`
	Comments []Comment            `json:"comments"`
}
type TextFile struct {
	Name     string `json:"name"`
	Contents string `json:"contents"`
	CacheKey string `json:"cacheKey"`
	sha1     string
}
type DiffFiles struct {
	OldFile *TextFile `json:"oldFile"`
	NewFile *TextFile `json:"newFile"`
}
