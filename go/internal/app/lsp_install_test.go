package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLanguageServerInstall(t *testing.T) {
	m, root, _ := fakeServers(t, "ok")
	bin := filepath.Dir(lookIn(environmentValue(m.environment(root), "PATH"), "fakels"))
	m.languages[0].Servers[0].command = "absent"
	// fakeinstall puts the missing server on PATH; it fails when asked to.
	script := "#!/bin/sh\n/bin/sleep 0.2\nif [ \"$1\" = fail ]; then echo 'formula not found' >&2; exit 1; fi\nprintf '#!/bin/sh\\n' > \"" + bin + "/absent\"\n/bin/chmod +x \"" + bin + "/absent\"\n"
	if err := os.WriteFile(filepath.Join(bin, "fakeinstall"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	m.languages[0].Installs = []installMethod{
		{"elsewhere", []string{"not-on-path", "fakels"}},
		{"fake", []string{"fakeinstall", "ok"}},
		{"broken", []string{"fakeinstall", "fail"}},
	}
	status := goStatus(m, root)
	if status.State != "missing" || len(status.Installs) != 2 || status.Installs[0] != (installOption{"fake", "fakeinstall ok"}) || status.Install != "fakeinstall ok" {
		t.Fatalf("offered installs: %+v", status)
	}
	for _, manager := range []string{"elsewhere", "unknown"} {
		if err := m.install(root, "go", manager); err == nil {
			t.Fatalf("%s installed", manager)
		}
	}

	if err := m.install(root, "go", "broken"); err != nil {
		t.Fatal(err)
	}
	if status := goStatus(m, root); status.Installing != "broken" {
		t.Fatalf("a running install: %+v", status)
	}
	if err := m.install(root, "go", "fake"); err == nil {
		t.Fatal("a second install ran alongside the first")
	}
	m.waitInstall("go")
	if status := goStatus(m, root); status.Installing != "" || status.InstallError == nil || status.InstallError.Manager != "broken" || !strings.Contains(status.InstallError.Log, "formula not found") {
		t.Fatalf("a failed install: %+v", status)
	}

	if err := m.install(root, "go", "fake"); err != nil {
		t.Fatal(err)
	}
	m.waitInstall("go")
	if status := goStatus(m, root); status.State != "idle" || status.Server == nil || status.InstallError != nil || status.Installs != nil {
		t.Fatalf("after installing: %+v", status)
	}
}
