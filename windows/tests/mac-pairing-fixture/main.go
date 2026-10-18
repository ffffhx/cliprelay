// Generates fresh, synthetic identities for Node TLS tests. Nothing is persisted.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"os"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--inspect-cert" {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 20000))
		if err != nil {
			panic(err)
		}
		block, _ := pem.Decode(data)
		if block == nil {
			panic("invalid certificate")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			panic(err)
		}
		if err = cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature); err != nil {
			panic(err)
		}
		if cert.IsCA || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
			panic("invalid client purpose")
		}
		if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"signature": hex.EncodeToString(cert.Signature)}); err != nil {
			panic(err)
		}
		return
	}
	result := make(map[string]map[string]string)
	var rootKey *rsa.PrivateKey
	var rootCert *x509.Certificate
	for _, name := range []string{"brokerRoot", "broker", "host", "client", "wrong"} {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
		if err != nil {
			panic(err)
		}
		template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "ClipRelay fixture " + name}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
		parent, signer := template, key
		if name == "brokerRoot" {
			template.IsCA = true
			template.BasicConstraintsValid = true
			template.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature
			template.ExtKeyUsage = nil
			rootKey = key
		} else if name == "broker" {
			parent, signer = rootCert, rootKey
		}
		der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, signer)
		if err != nil {
			panic(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			panic(err)
		}
		if name == "brokerRoot" {
			rootCert = cert
			result[name] = map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "signature": hex.EncodeToString(cert.Signature)}
			continue
		}
		private, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			panic(err)
		}
		result[name] = map[string]string{"cert": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), "key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})), "signature": hex.EncodeToString(cert.Signature)}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}
