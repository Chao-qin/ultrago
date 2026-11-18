package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func discover() ([]byte, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(base, "UltraGoDesktop", "runtime.json"))
	if err != nil {
		return nil, fmt.Errorf("请先打开 UltraGo 客户端")
	}
	var descriptor struct {
		Version    int    `json:"version"`
		Origin     string `json:"origin"`
		Token      string `json:"token"`
		Generation string `json:"generation"`
	}
	if json.Unmarshal(data, &descriptor) != nil || descriptor.Version != 1 || len(descriptor.Token) != 64 {
		return nil, fmt.Errorf("客户端连接信息无效")
	}
	u, err := url.Parse(descriptor.Origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return nil, fmt.Errorf("客户端连接地址无效")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("客户端连接端口无效")
	}
	req, err := http.NewRequest("GET", descriptor.Origin+"/__desktop/discover", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+descriptor.Token)
	client := http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("客户端未运行，请重新打开客户端")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("客户端连接信息已失效")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil || len(body) > 65536 {
		return nil, fmt.Errorf("连接响应无效")
	}
	var reply map[string]interface{}
	if json.Unmarshal(body, &reply) != nil {
		return nil, fmt.Errorf("连接响应无效")
	}
	if reply["error"] == nil && reply["generation"] != descriptor.Generation {
		return nil, fmt.Errorf("客户端已重启，请重新连接")
	}
	return body, nil
}

func exchange(input io.Reader, output io.Writer) error {
	var length uint32
	if err := binary.Read(input, binary.LittleEndian, &length); err != nil {
		return err
	}
	if length == 0 || length > 4096 {
		return fmt.Errorf("native message too large")
	}
	message := make([]byte, length)
	if _, err := io.ReadFull(input, message); err != nil {
		return err
	}
	var request struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(message, &request) != nil || request.Type != "discover" {
		return fmt.Errorf("invalid native message")
	}
	body, err := discover()
	if err != nil {
		body, _ = json.Marshal(map[string]string{"error": err.Error()})
	}
	var frame bytes.Buffer
	if err := binary.Write(&frame, binary.LittleEndian, uint32(len(body))); err != nil {
		return err
	}
	frame.Write(body)
	_, err = output.Write(frame.Bytes())
	return err
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--mcp-stdio" {
		if err := launchMcp(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := exchange(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
