package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// applicationPath is the client executable next to the resources folder. electron-builder names it after the
// product name: UltraGo.exe beside resources on Windows, Contents/MacOS/UltraGo beside Contents/Resources on macOS.
func applicationPath(resources, goos string) string {
	if goos == "darwin" {
		return filepath.Join(filepath.Dir(resources), "MacOS", "UltraGo")
	}
	return filepath.Join(filepath.Dir(resources), "UltraGo.exe")
}

func mcpCommand(host, config string) *exec.Cmd {
	resources := filepath.Dir(filepath.Dir(host))
	application := applicationPath(resources, runtime.GOOS)
	entry := filepath.Join(resources, "mcp-entry.cjs")
	command := exec.Command(application, entry, filepath.Join(config, "UltraGoDesktop", "runtime.json"))
	for _, value := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(value, "=", 2)[0])
		if key != "ELECTRON_RUN_AS_NODE" && key != "NODE_OPTIONS" {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "ELECTRON_RUN_AS_NODE=1")
	return command
}

func launchMcp() error {
	host, err := os.Executable()
	if err != nil {
		return err
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	command := mcpCommand(host, config)
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	errors, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		_, copyError := io.Copy(input, os.Stdin)
		input.Close()
		if copyError != nil {
			fmt.Fprintln(os.Stderr, "MCP 输入已关闭：", copyError)
		}
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			if err := command.Process.Kill(); err != nil && err != os.ErrProcessDone {
				fmt.Fprintln(os.Stderr, "MCP 子进程清理失败：", err)
			}
		}
	}()
	var streams sync.WaitGroup
	streams.Add(2)
	go func() {
		defer streams.Done()
		if _, err := io.Copy(os.Stdout, output); err != nil {
			fmt.Fprintln(os.Stderr, "MCP 输出已关闭：", err)
		}
	}()
	go func() {
		defer streams.Done()
		if _, err := io.Copy(os.Stderr, errors); err != nil {
			fmt.Fprintln(os.Stderr, "MCP 错误流已关闭：", err)
		}
	}()
	streams.Wait()
	err = command.Wait()
	close(done)
	if err != nil {
		return fmt.Errorf("MCP 连接进程退出：%w", err)
	}
	return nil
}
