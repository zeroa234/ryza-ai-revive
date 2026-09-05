package com.ryza.chat;

import android.content.res.AssetManager;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tiny local HTTP server over AssetManager so Spine/fetch see
 * http://127.0.0.1, plus POST /_proxy?u=https://... which forwards the LLM /
 * TTS call (browser WebView has no CORS escape otherwise). Same contract as
 * scripts/serve.py and desktop/main.js.
 */
public final class AssetServer extends Thread {
    private final AssetManager assets;
    private final int port;
    private volatile boolean running = true;
    private ServerSocket server;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("svg", "image/svg+xml");
        MIME.put("atlas", "text/plain; charset=utf-8");
        MIME.put("skel", "application/octet-stream");
        MIME.put("m4a", "audio/mp4");
        MIME.put("wav", "audio/wav");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("ttf", "font/ttf");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
    }

    public AssetServer(AssetManager assets, int port) {
        this.assets = assets;
        this.port = port;
        setName("asset-http");
        setDaemon(true);
    }

    @Override public void run() {
        try {
            server = new ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"));
            while (running) {
                final Socket sock = server.accept();
                pool.execute(() -> handle(sock));
            }
        } catch (IOException e) {
            if (running) e.printStackTrace();
        }
    }

    public void stopServer() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        pool.shutdownNow();
    }

    private void handle(Socket sock) {
        try (Socket s = sock;
             InputStream in = new BufferedInputStream(s.getInputStream());
             OutputStream out = s.getOutputStream()) {
            String line = readLine(in);
            if (line == null || line.isEmpty()) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) { write(out, 400, "text/plain", "bad request"); return; }
            String method = parts[0].toUpperCase(Locale.US);
            Headers hs = readHeaders(in);
            if ("OPTIONS".equals(method)) {
                writeBytes(out, 204, "text/plain", new byte[0],
                    "Access-Control-Allow-Headers: Authorization, Content-Type, api-key\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n");
                return;
            }
            String rawUrl = parts[1];
            if ("POST".equals(method) && rawUrl.startsWith("/_proxy")) {
                proxy(rawUrl, hs, in, out);
                return;
            }
            if ("GET".equals(method) && rawUrl.startsWith("/_proxy")) {
                proxyGet(rawUrl, hs, out);
                return;
            }
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                write(out, 405, "text/plain", "method not allowed"); return;
            }
            String path = URLDecoder.decode(rawUrl.split("\\?")[0], "UTF-8");
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty()) path = "index.html";
            if (path.contains("..")) { write(out, 403, "text/plain", "forbidden"); return; }
            /* providers.json never ships; answer 404 fast instead of a
               full asset scan per boot (hydrate() treats it as optional). */
            if (path.startsWith("config/")) { write(out, 404, "text/plain", "not bundled"); return; }
            try (InputStream file = assets.open(path)) {
                String ext = "";
                int dot = path.lastIndexOf('.');
                if (dot >= 0) ext = path.substring(dot + 1).toLowerCase(Locale.US);
                String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                byte[] data = readAll(file);
                writeBytes(out, 200, mime, data, "");
            } catch (IOException e) {
                write(out, 404, "text/plain", "not found: " + path);
            }
        } catch (IOException ignored) {}
    }

    private static class Headers {
        int contentLength = 0;
        String contentType = "application/json";
        String authorization = null;
        String apiKey = null;
    }

    private Headers readHeaders(InputStream in) throws IOException {
        Headers h = new Headers();
        while (true) {
            String l = readLine(in);
            if (l == null || l.isEmpty()) break;
            int c = l.indexOf(':');
            if (c < 0) continue;
            String k = l.substring(0, c).trim().toLowerCase(Locale.US);
            String v = l.substring(c + 1).trim();
            if ("content-length".equals(k)) { try { h.contentLength = Integer.parseInt(v); } catch (NumberFormatException ignored) {} }
            else if ("content-type".equals(k)) h.contentType = v;
            else if ("authorization".equals(k)) h.authorization = v;
            else if ("api-key".equals(k)) h.apiKey = v;
        }
        return h;
    }

    /** POST /_proxy?u=https%3A%2F%2F... — body + auth headers forwarded. */
    private void proxy(String rawUrl, Headers hs, InputStream in, OutputStream out) throws IOException {
        String target = "";
        int q = rawUrl.indexOf('?');
        if (q >= 0) {
            for (String kv : rawUrl.substring(q + 1).split("&")) {
                int e = kv.indexOf('=');
                if (e > 0 && "u".equals(kv.substring(0, e))) {
                    target = URLDecoder.decode(kv.substring(e + 1), "UTF-8");
                }
            }
        }
        byte[] body = new byte[0];
        if (hs.contentLength > 0) {
            body = new byte[hs.contentLength];
            int off = 0;
            while (off < body.length) {
                int n = in.read(body, off, body.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        if (!target.startsWith("https://")) {
            write(out, 400, "application/json", "{\"error\":{\"message\":\"proxy target must be https\"}}");
            return;
        }
        try {
            HttpURLConnection up = (HttpURLConnection) new URL(target).openConnection();
            up.setRequestMethod("POST");
            up.setConnectTimeout(20000);
            up.setReadTimeout(180000);
            up.setDoOutput(true);
            up.setRequestProperty("Content-Type", hs.contentType);
            up.setRequestProperty("User-Agent", "RyzaChat/1.2.13");
            if (hs.authorization != null) up.setRequestProperty("Authorization", hs.authorization);
            if (hs.apiKey != null) up.setRequestProperty("api-key", hs.apiKey);
            if (body.length > 0) {
                OutputStream ub = up.getOutputStream();
                ub.write(body);
                ub.flush();
                ub.close();
            }
            int code = up.getResponseCode();
            InputStream is = code >= 400 ? up.getErrorStream() : up.getInputStream();
            byte[] resp = is == null ? new byte[0] : readAll(is);
            String ct = up.getContentType() == null ? "application/json" : up.getContentType();
            up.disconnect();
            writeBytes(out, code >= 100 && code <= 599 ? code : 502, ct, resp, "");
        } catch (IOException e) {
            String msg = "{\"error\":{\"message\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}}";
            write(out, 502, "application/json", msg);
        }
    }

    /** GET /_proxy?u=https%3A%2F%2F... — audio URL passthrough + /v1/models. */
    private void proxyGet(String rawUrl, Headers hs, OutputStream out) throws IOException {
        String target = "";
        int q = rawUrl.indexOf('?');
        if (q >= 0) {
            for (String kv : rawUrl.substring(q + 1).split("&")) {
                int e = kv.indexOf('=');
                if (e > 0 && "u".equals(kv.substring(0, e))) {
                    target = URLDecoder.decode(kv.substring(e + 1), "UTF-8");
                }
            }
        }
        if (!target.startsWith("https://")) {
            write(out, 400, "application/json", "{\"error\":{\"message\":\"proxy target must be https\"}}");
            return;
        }
        try {
            HttpURLConnection up = (HttpURLConnection) new URL(target).openConnection();
            up.setRequestMethod("GET");
            up.setConnectTimeout(20000);
            up.setReadTimeout(120000);
            up.setInstanceFollowRedirects(true);
            up.setRequestProperty("User-Agent", "RyzaChat/1.2.13");
            if (hs != null && hs.authorization != null) up.setRequestProperty("Authorization", hs.authorization);
            if (hs != null && hs.apiKey != null) up.setRequestProperty("api-key", hs.apiKey);
            int code = up.getResponseCode();
            InputStream is = code >= 400 ? up.getErrorStream() : up.getInputStream();
            byte[] resp = is == null ? new byte[0] : readAll(is);
            String ct = up.getContentType() == null ? "application/octet-stream" : up.getContentType();
            up.disconnect();
            writeBytes(out, code, ct, resp, "");
        } catch (IOException e) {
            write(out, 502, "application/json", "{\"error\":{\"message\":\"proxy get failed\"}}");
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] tmp = new byte[16 * 1024];
        int n;
        while ((n = in.read(tmp)) >= 0) buf.write(tmp, 0, n);
        return buf.toByteArray();
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder b = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.append((char) c);
        }
        return c == -1 && b.length() == 0 ? null : b.toString();
    }

    private static void write(OutputStream out, int code, String mime, String body) throws IOException {
        writeBytes(out, code, mime, body.getBytes("UTF-8"), "");
    }

    private static void writeBytes(OutputStream out, int code, String mime, byte[] body, String extra) throws IOException {
        String status = code == 200 ? "OK" : (code == 204 ? "No Content" : (code == 404 ? "Not Found" : "Status"));
        String head = "HTTP/1.1 " + code + " " + status + "\r\n"
            + "Content-Type: " + mime + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + extra
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        if (code != 204) out.write(body);
        out.flush();
    }
}
