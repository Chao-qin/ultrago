package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMcpLauncherUsesPackagedRuntimeAndExplicitStdio(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--require developer.js")
	host := filepath.Join(t.TempDir(), "UltraGo", "resources", "native", "bcp-native-host.exe")
	config := filepath.Join(t.TempDir(), "用户数据")
	command := mcpCommand(host, config)
	if command.Path != applicationPath(filepath.Dir(filepath.Dir(host)), runtime.GOOS) {
		t.Fatal(command.Path)
	}
	if command.Args[1] != filepath.Join(filepath.Dir(filepath.Dir(host)), "mcp-entry.cjs") {
		t.Fatal(command.Args)
	}
	if command.Stdin != nil || command.Stdout != nil || command.Stderr != nil {
		t.Fatal("launcher must allocate fresh pipes instead of inheriting GUI handles")
	}
	joined := strings.Join(command.Env, "\n")
	if !strings.Contains(joined, "ELECTRON_RUN_AS_NODE=1") || strings.Contains(joined, "NODE_OPTIONS=") {
		t.Fatal("invalid runtime environment")
	}
}

func TestApplicationPathFollowsEachPackageLayout(t *testing.T) {
	windows := applicationPath(filepath.Join("C:", "UltraGo", "resources"), "windows")
	if windows != filepath.Join("C:", "UltraGo", "UltraGo.exe") {
		t.Fatal(windows)
	}
	mac := applicationPath(filepath.Join("/Applications", "UltraGo.app", "Contents", "Resources"), "darwin")
	if mac != filepath.Join("/Applications", "UltraGo.app", "Contents", "MacOS", "UltraGo") {
		t.Fatal(mac)
	}
}

func TestRejectsMalformedFrames(t *testing.T) {
	for _, length := range []uint32{0, 4097} {
		var input, output bytes.Buffer
		binary.Write(&input, binary.LittleEndian, length)
		if exchange(&input, &output) == nil {
			t.Fatalf("accepted length %d", length)
		}
	}
	var input, output bytes.Buffer
	binary.Write(&input, binary.LittleEndian, uint32(100))
	input.WriteString("{}")
	if exchange(&input, &output) == nil {
		t.Fatal("accepted truncated frame")
	}
}

func TestCurrentRuntimeDiscovery(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	t.Setenv("APPDATA", base)
	dir := filepath.Join(base, "UltraGoDesktop")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	generation := "current"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			t.Error("missing runtime credential")
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"version": 1, "generation": generation, "backendUrl": "ws://127.0.0.1:41234", "token": strings.Repeat("b", 64)})
	}))
	defer server.Close()
	write := func(origin string) {
		data, _ := json.Marshal(map[string]interface{}{"version": 1, "generation": "current", "origin": origin, "token": strings.Repeat("a", 64)})
		if err := os.WriteFile(filepath.Join(dir, "runtime.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(server.URL)
	var input, output bytes.Buffer
	message := []byte(`{"type":"discover"}`)
	binary.Write(&input, binary.LittleEndian, uint32(len(message)))
	input.Write(message)
	if err := exchange(&input, &output); err != nil {
		t.Fatal(err)
	}
	var length uint32
	binary.Read(&output, binary.LittleEndian, &length)
	if int(length) != output.Len() {
		t.Fatal("invalid length prefix")
	}
	if !json.Valid(output.Bytes()) {
		t.Fatal("invalid JSON reply")
	}
	generation = "stale"
	if _, err := discover(); err == nil {
		t.Fatal("accepted stale generation")
	}
	write("http://example.com:41234")
	if _, err := discover(); err == nil {
		t.Fatal("accepted non-loopback host")
	}
}
