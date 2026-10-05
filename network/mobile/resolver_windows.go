package mobile

import (
	"net"

	"tailscale.com/net/dnscache"
)

func init() {
	// Use Windows' resolver, including its interface selection, cache and DNS
	// policy. The upstream pure-Go resolver can time out against an inactive
	// adapter's DNS server when running as LocalSystem. Set this before any
	// tsnet node starts; the setting is confined to our helper process.
	dnscache.Get().Forward = &net.Resolver{PreferGo: false}
}
