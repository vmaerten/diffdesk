package app

// Set by the build; direct `go build` remains usable for development.
var version = "dev"
var commit = "unknown"
var buildDate = "unknown"

type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"buildDate"`
}

func buildInfo() BuildInfo {
	return BuildInfo{version, commit, buildDate}
}
