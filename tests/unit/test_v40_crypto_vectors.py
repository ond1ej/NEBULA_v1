"""NEBULA 4.0: the server accepts exactly what the Swift apps produce (vector made with Apple CryptoKit:
P256.Signing.PrivateKey, x963Representation, ECDSA SHA-256 derRepresentation) — and nothing else."""

import hashlib

from nebula_host import devices

PUB = "BHw2YWLJ0/jL8Amo2zeFotsE+iJbq7D9ndfiZHOARyAhVRr+0I+dZlJiCByn5Qr2ljmHogpbSMYi346xxvQuuaM="
SIG = "MEUCIFfEKBL/h/LsjuIYKy666m1blfsGKxfgjkgrXUgUrVR1AiEAtq7xc6035PseF2F17Dc2j3iNe4/bvaXzUAZ04XUV4wg="


def test_cryptokit_confirmation_signature_verifies_on_the_server():
    digest = hashlib.sha256(bytes([7]) * 32).hexdigest()
    assert digest == "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0"  # same as Swift's sha256Hex
    payload = devices.confirm_payload("adv_0011223344556677", "sess-1", "cid-1", "chal-1", "vault_unlock", digest)
    assert devices.verify_signature(PUB, payload, SIG)
    assert not devices.verify_signature(PUB, payload + b" ", SIG)
    assert not devices.verify_signature(PUB, devices.confirm_payload(
        "adv_0011223344556677", "sess-2", "cid-1", "chal-1", "vault_unlock", digest), SIG)  # another session
