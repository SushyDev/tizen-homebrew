package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"testing"

	"github.com/dop251/goja"
)

// The engine has to run what the television runs, unchanged: these files are the service's own and
// are not ported, so a syntax the engine cannot read is a design failure rather than a detail.
func TestParsesSharedSources(t *testing.T) {
	for _, path := range []string{
		"../service/src/tv/adb.js",
		"../service/src/tv/sdb.js",
		"../service/src/install/signature.js",
		"../service/src/install/resign.js",
		"../service/src/install/verdicts.js",
		"../node_modules/jszip/dist/jszip.min.js",
		"../node_modules/node-forge/dist/forge.min.js",
	} {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}

		if _, err := goja.Compile(path, string(source), true); err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}

		t.Logf("%s: parses", path)
	}
}

// The shape the design rests on: the logic stays in the JavaScript the TV also runs, and the
// expensive primitives are the host's. Pure-JS keygen takes over three minutes in the engine and
// thirty milliseconds in Go, so forge is handed a key it did not make — and must not notice.
func TestHostKeygenSatisfiesForge(t *testing.T) {
	source, err := os.ReadFile("../node_modules/node-forge/dist/forge.min.js")
	if err != nil {
		t.Fatal(err)
	}

	vm := goja.New()

	if _, err := vm.RunString("var window = this; var self = this;"); err != nil {
		t.Fatal(err)
	}

	if _, err := vm.RunString(string(source)); err != nil {
		t.Fatal(err)
	}

	if err := vm.Set("__generateRsaPem", func(bits int) string {
		key, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			t.Fatal(err)
		}

		return string(pem.EncodeToMemory(&pem.Block{
			Type:  "RSA PRIVATE KEY",
			Bytes: x509.MarshalPKCS1PrivateKey(key),
		}))
	}); err != nil {
		t.Fatal(err)
	}

	value, err := vm.RunString(`
		forge.pki.rsa.generateKeyPair = function (options) {
			var privateKey = forge.pki.privateKeyFromPem(__generateRsaPem((options && options.bits) || 2048));
			return { privateKey: privateKey, publicKey: forge.pki.setRsaPublicKey(privateKey.n, privateKey.e) };
		};

		var pair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
		var md = forge.md.sha256.create();
		md.update('tizen homebrew');

		pair.publicKey.verify(md.digest().bytes(), pair.privateKey.sign(md));
	`)
	if err != nil {
		t.Fatalf("patched keygen: %v", err)
	}

	if !value.ToBoolean() {
		t.Fatal("forge would not verify what it signed with a host-generated key")
	}
}
