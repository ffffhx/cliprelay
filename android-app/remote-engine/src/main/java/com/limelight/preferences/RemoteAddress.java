package com.limelight.preferences;

import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;

import java.net.URI;
import java.net.URISyntaxException;

/** Parses the address field without DNS or network work on the UI thread. */
public final class RemoteAddress {
    private RemoteAddress() {}

    public static ComputerDetails.AddressTuple parse(String input) {
        String raw = input.trim();
        if (raw.isEmpty()) throw new IllegalArgumentException("Empty address");
        URI uri = parseUri(raw);
        // Unbracketed IPv6 literals do not have an authority host in java.net.URI.
        if (uri == null && raw.contains(":")) uri = parseUri("[" + raw + "]");
        if (uri == null) throw new IllegalArgumentException("Invalid address");
        int port = uri.getPort();
        if (port == -1) port = NvHTTP.DEFAULT_HTTP_PORT;
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid port");
        return new ComputerDetails.AddressTuple(uri.getHost(), port);
    }

    private static URI parseUri(String input) {
        try {
            URI uri = new URI("cliprelay://" + input);
            if (uri.getHost() == null || uri.getHost().isEmpty() || uri.getRawUserInfo() != null ||
                    uri.getRawQuery() != null || uri.getRawFragment() != null ||
                    (uri.getRawPath() != null && !uri.getRawPath().isEmpty()) ||
                    uri.getRawAuthority().endsWith(":")) return null;
            return uri;
        } catch (URISyntaxException error) {
            return null;
        }
    }
}
