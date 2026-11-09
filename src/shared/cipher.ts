// XOR-AB autokey cipher used by all Kasa "smarthome" endpoints (UDP/9999 discovery,
// the LINKIE2 control protocol). Initial key 0xAB; each output byte becomes the next key,
// so encrypt and decrypt only differ in which side feeds the key forward (the cipher byte
// in both cases — the same primitive, just different direction).

// Both overwrite the input buffer instead of allocating a fresh one; every caller owns the
// buffer it passes (a Buffer.from(...) it just made, or a datagram it's about to throw away).
export function xorEncryptInPlace(plaintext: Buffer): Buffer {
    let key = 0xab;
    for (let i = 0; i < plaintext.length; i++) {
        const c = key ^ plaintext[i];
        plaintext[i] = c;
        key = c;
    }
    return plaintext;
}

export function xorDecryptInPlace(ciphertext: Buffer): Buffer {
    let key = 0xab;
    for (let i = 0; i < ciphertext.length; i++) {
        const c = ciphertext[i];
        ciphertext[i] = key ^ c;
        key = c;
    }
    return ciphertext;
}
