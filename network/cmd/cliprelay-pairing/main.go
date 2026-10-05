package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"cliprelay/network/broker"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18081", "private HTTP listener")
	state := flag.String("state", "/var/lib/cliprelay-network/pairing.json", "private state")
	keyFile := flag.String("api-key-file", "/var/lib/cliprelay-network/headscale-api-key", "private Headscale administrative key")
	control := flag.String("control-url", "https://124-221-36-36.anyip.dev:8443", "public coordination origin")
	flag.Parse()
	key, err := os.ReadFile(*keyFile)
	if err != nil {
		log.Fatal("cannot read coordination credential file")
	}
	s, err := broker.New(&broker.Headscale{URL: "http://127.0.0.1:18080", APIKey: strings.TrimSpace(string(key))}, *control, *state)
	if err != nil {
		log.Fatal("cannot open pairing state")
	}
	server := &http.Server{Addr: *listen, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Fatal(server.ListenAndServe())
}
