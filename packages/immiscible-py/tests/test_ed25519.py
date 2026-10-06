"""The pure-Python Ed25519 verifier, against RFC 8032 and against Node's crypto."""

import hashlib
import json
import pathlib
import unittest

from immiscible import ed25519

FIXTURES = json.loads((pathlib.Path(__file__).parent / "fixtures" / "node_vectors.json").read_text("utf-8"))

# RFC 8032, section 7.1: TEST 1, TEST 2, TEST 3 and TEST SHA(abc). (Public key, message, signature.)
RFC8032 = [
    ("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
    ("ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf", hashlib.sha512(b"abc").hexdigest(),
     "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704"),
]

h = bytes.fromhex


class RFC8032Vectors(unittest.TestCase):
    def test_valid(self):
        for pk, msg, sig in RFC8032:
            with self.subTest(pk=pk[:8]):
                self.assertTrue(ed25519.verify(h(pk), h(msg), h(sig)))

    def test_wrong_message(self):
        for pk, msg, sig in RFC8032:
            with self.subTest(pk=pk[:8]):
                self.assertFalse(ed25519.verify(h(pk), h(msg) + b"x", h(sig)))

    def test_every_signature_bit_matters(self):
        pk, msg, sig = RFC8032[1]
        for i in range(0, 64, 5):
            t = bytearray(h(sig))
            t[i] ^= 0x10
            self.assertFalse(ed25519.verify(h(pk), h(msg), bytes(t)), i)

    def test_wrong_key(self):
        self.assertFalse(ed25519.verify(h(RFC8032[0][0]), h(RFC8032[1][1]), h(RFC8032[1][2])))

    def test_s_at_or_above_group_order_is_refused(self):
        # Malleability: S + L satisfies the group equation, but must be refused.
        pk, msg, sig = RFC8032[0]
        s = int.from_bytes(h(sig)[32:], "little") + ed25519.L
        forged = h(sig)[:32] + s.to_bytes(32, "little")
        self.assertFalse(ed25519.verify(h(pk), h(msg), forged))

    def test_bad_lengths_and_points(self):
        pk, msg, sig = RFC8032[0]
        self.assertFalse(ed25519.verify(h(pk), h(msg), h(sig)[:63]))
        with self.assertRaises(ed25519.InvalidKey):
            ed25519.verify(h(pk)[:31], h(msg), h(sig))
        # y >= p is not a canonical encoding.
        self.assertFalse(ed25519.verify(b"\xff" * 31 + b"\x7f", h(msg), h(sig)))


class NodeCryptoInterop(unittest.TestCase):
    def test_node_signatures_verify(self):
        vs = FIXTURES["signatures"]
        self.assertGreaterEqual(len(vs), 20)
        for v in vs:
            with self.subTest(msg_len=len(v["message"]) // 2):
                self.assertTrue(ed25519.verify(h(v["public_key"]), h(v["message"]), h(v["signature"])))

    def test_node_signatures_fail_when_altered(self):
        for v in FIXTURES["signatures"][:8]:
            sig = bytearray(h(v["signature"]))
            sig[40] ^= 1
            self.assertFalse(ed25519.verify(h(v["public_key"]), h(v["message"]), bytes(sig)))
            self.assertFalse(ed25519.verify(h(v["public_key"]), h(v["message"]) + b"\x00", h(v["signature"])))


class FakeSigner(unittest.TestCase):
    """The fake server's signer must produce RFC 8032 signatures, or its receipts would prove nothing."""

    def test_rfc8032_test_1_and_2(self):
        from immiscible.testing import Ed25519Signer
        s1 = Ed25519Signer(h("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
        self.assertEqual(s1.public_key.hex(), RFC8032[0][0])
        self.assertEqual(s1.sign(b"").hex(), RFC8032[0][2])
        s2 = Ed25519Signer(h("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"))
        self.assertEqual(s2.public_key.hex(), RFC8032[1][0])
        self.assertEqual(s2.sign(h("72")).hex(), RFC8032[1][2])


if __name__ == "__main__":
    unittest.main()
