// Throwaway benchmark. Not a proposed implementation of ghl.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
)

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Println(listener.Addr().(*net.TCPAddr).Port)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		var err error
		switch r.URL.Path {
		case "/health":
			body = []byte("{\"ok\":true}\n")
		case "/":
			body, err = os.ReadFile(os.Getenv("BENCH_INDEX"))
		case "/asset":
			body, err = os.ReadFile(os.Getenv("BENCH_ASSET"))
		case "/diff":
			body, err = exec.Command("git", "-C", os.Getenv("BENCH_REPO"), "diff", "--no-ext-diff", "--no-color", "HEAD").Output()
		default:
			err = fmt.Errorf("unknown route")
		}
		w.Header().Set("Connection", "close")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
	})}
	server.SetKeepAlivesEnabled(false)
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
