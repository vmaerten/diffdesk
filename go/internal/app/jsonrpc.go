package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
)

// A language server's answer can list thousands of references; anything
// larger than this is a broken stream, not an answer.
const maxFrameBytes = 32 << 20

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

// rpcHandlers answer what the server sends: requests need a result, and
// notifications none.
type rpcHandlers struct {
	request func(method string, params json.RawMessage) (any, error)
	notify  func(method string, params json.RawMessage)
}

// rpcConn speaks JSON-RPC 2.0 with Content-Length framing, the transport of
// the Language Server Protocol, over a server's stdin and stdout.
type rpcConn struct {
	writeMu  sync.Mutex
	w        io.Writer
	handlers rpcHandlers

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan rpcMessage
	err     error
	done    chan struct{}
}

func newRPCConn(w io.Writer, r io.Reader, handlers rpcHandlers) *rpcConn {
	c := &rpcConn{w: w, handlers: handlers, pending: map[int64]chan rpcMessage{}, done: make(chan struct{})}
	go c.read(r)
	return c
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	header, err := textproto.NewReader(r).ReadMIMEHeader()
	if err != nil {
		return nil, err
	}
	length, err := strconv.Atoi(header.Get("Content-Length"))
	if err != nil || length < 0 || length > maxFrameBytes {
		return nil, fmt.Errorf("invalid Content-Length %q", header.Get("Content-Length"))
	}
	body := make([]byte, length)
	_, err = io.ReadFull(r, body)
	return body, err
}

func (c *rpcConn) read(r io.Reader) {
	reader := bufio.NewReader(r)
	for {
		body, err := readFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				err = errors.New("language server closed its output")
			}
			c.close(err)
			return
		}
		var message rpcMessage
		if json.Unmarshal(body, &message) != nil {
			continue
		}
		switch {
		case message.Method != "" && message.ID != nil:
			c.answer(message)
		case message.Method != "":
			if c.handlers.notify != nil {
				c.handlers.notify(message.Method, message.Params)
			}
		default:
			id, err := strconv.ParseInt(string(message.ID), 10, 64)
			if err != nil {
				continue
			}
			c.mu.Lock()
			reply := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if reply != nil {
				reply <- message
			}
		}
	}
}

// answer replies to a request from the server. A server waits for some of
// these, such as workspace/configuration, before it answers anything else.
func (c *rpcConn) answer(request rpcMessage) {
	var result any
	err := error(&rpcError{Code: -32601, Message: "method not found: " + request.Method})
	if c.handlers.request != nil {
		result, err = c.handlers.request(request.Method, request.Params)
	}
	reply := rpcMessage{ID: request.ID}
	if err != nil {
		var known *rpcError
		if !errors.As(err, &known) {
			known = &rpcError{Code: -32603, Message: err.Error()}
		}
		reply.Error = known
	} else if reply.Result, err = json.Marshal(result); err != nil {
		reply.Result = nil
		reply.Error = &rpcError{Code: -32603, Message: err.Error()}
	}
	_ = c.send(reply)
}

func (c *rpcConn) close(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return
	}
	c.err = err
	close(c.done)
}

func (c *rpcConn) closed() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *rpcConn) send(message rpcMessage) error {
	message.JSONRPC = "2.0"
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = io.WriteString(c.w, "Content-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+string(body))
	return err
}

func rawParams(params any) (json.RawMessage, error) {
	if params == nil {
		return nil, nil
	}
	return json.Marshal(params)
}

func (c *rpcConn) notify(method string, params any) error {
	raw, err := rawParams(params)
	if err != nil {
		return err
	}
	return c.send(rpcMessage{Method: method, Params: raw})
}

// call sends a request and decodes its result into result, which may be nil.
// Cancelling ctx tells the server, which may then stop working on it.
func (c *rpcConn) call(ctx context.Context, method string, params, result any) error {
	raw, err := rawParams(params)
	if err != nil {
		return err
	}
	reply := make(chan rpcMessage, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return c.err
	}
	c.nextID++
	id := c.nextID
	c.pending[id] = reply
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	if err := c.send(rpcMessage{ID: json.RawMessage(strconv.FormatInt(id, 10)), Method: method, Params: raw}); err != nil {
		forget()
		return err
	}
	select {
	case message := <-reply:
		if message.Error != nil {
			return fmt.Errorf("%s: %w", method, message.Error)
		}
		if result == nil || len(message.Result) == 0 || strings.TrimSpace(string(message.Result)) == "null" {
			return nil
		}
		return json.Unmarshal(message.Result, result)
	case <-ctx.Done():
		forget()
		_ = c.notify("$/cancelRequest", map[string]int64{"id": id})
		return ctx.Err()
	case <-c.done:
		return c.closed()
	}
}
