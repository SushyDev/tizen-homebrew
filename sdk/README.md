# sdk

Certificates, signing and packaging for Tizen, with no Tizen Studio, no `tizen` package and no
dependencies beyond `jszip`.

It replaces [`reisxd/tizen.js`](https://github.com/reisxd/tizen.js), which the repository used to
carry as a git-tarball dependency, and with it `node-forge`, `node-fetch`, `form-data`, `commander`
and `@xmldom/xmldom`.

## What is in here

| | |
| --- | --- |
| `der.js` | DER, and BER's indefinite lengths, because Java writes those |
| `oids.js` | the object identifiers the rest of it names |
| `kdf.js` | the key derivation PKCS#12 uses, which is not PBKDF2 |
| `rc2.js` | RC2-CBC decryption, which OpenSSL 3 left in the legacy provider |
| `pkcs12.js` | read and write a `.p12` |
| `pkcs10.js` | the certificate request a certificate authority signs |
| `x509.js` | which televisions a certificate names, and when it expires |
| `authority.js` | the Samsung VD certificate authorities, as source |
| `samsung.js` | the three endpoints that issue a pair |
| `signing.js` | the two XML signatures a package carries |
| `packaging.js` | read, build, re-sign and inspect a `.wgt` |
| `staging.js` | a directory read as package contents |

`signing.js` and `packaging.js` are the only parts that run on a television; nothing else is
reachable from `service/`.

## What changed against upstream

- **The certificate authorities are bundled.** Upstream downloads a 44 MB SDK extension on every
  fresh machine, unpacks a zip out of a zip out of a jar, and leaves the result in `~/share`. The
  three certificates it is after are 5 KB and are in `authority.js`. `npm run authority` refreshes
  them.
- **The device profile is fetched again.** `/apis/v1/distributors` answers with the profile that is
  staged on the set. Upstream lost that call when Samsung moved domain and posts to the certificate
  endpoint twice instead, so the file it writes as `device-profile.xml` is a second copy of the
  certificate. This asks v1, and falls back to the certificate if the answer is not a document.
- **A PKCS#12 is opened rather than guessed at.** The MAC is checked, so a wrong password says so
  instead of surfacing as "holds no private key". Files from node-forge, from Tizen Studio
  (RC2-40 certificate bags, `PBEWithSHA1AndDESede` key) and from OpenSSL all open.
- **RC2 is correct at effective key lengths that are not a whole number of bytes.** node-forge masks
  by `bits & 7` where RFC 2268 says `255 mod 2^(8 + T1 - 8*T8)`, and fails two of the RFC's own test
  vectors. `test/rc2.js` runs all eight.
- **A package can be inspected.** `packaging.inspect` recomputes every digest a signature claims and
  names the ones that no longer match.
- **A certificate's expiry is readable**, so `npm run doctor` and `npm run package` can say that a
  pair is about to lapse rather than letting the television refuse the install.

## Tests

`npm test` runs them. `test/fixtures/signers.js` carries a `.p12` written by node-forge, the same
pair written by OpenSSL the way Tizen Studio writes one, and a second unrelated signer — base64
rather than files, because this repository refuses to track a `.p12`. Beside it are the two
signature documents the `tizen` package's own signer produced, so byte-identity is still checked now
that the dependency is gone. The keys are throwaway.
