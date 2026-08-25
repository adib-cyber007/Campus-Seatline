package edu.campus.seatline;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureSessionStore {
    private static final String PREFERENCES = "seatline_native_push_session";
    private static final String KEY_ALIAS = "seatline_push_action_key_v1";
    private static final String API_ORIGIN = "api_origin";
    private static final String USER_ID = "user_id";
    private static final String ENCRYPTED_TOKEN = "encrypted_token";
    private static final Object LOCK = new Object();

    private SecureSessionStore() {}

    static void save(Context context, String apiOrigin, String authToken, String userId)
        throws GeneralSecurityException {
        synchronized (LOCK) {
            String encrypted = encrypt(authToken);
            boolean saved = preferences(context).edit()
                .putString(API_ORIGIN, apiOrigin)
                .putString(USER_ID, userId)
                .putString(ENCRYPTED_TOKEN, encrypted)
                .commit();
            if (!saved) throw new GeneralSecurityException("Could not persist notification session");
        }
    }

    static Session load(Context context) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String apiOrigin = preferences.getString(API_ORIGIN, "");
            String userId = preferences.getString(USER_ID, "");
            String encryptedToken = preferences.getString(ENCRYPTED_TOKEN, "");
            if (apiOrigin.isEmpty() || userId.isEmpty() || encryptedToken.isEmpty()) return null;
            try {
                return new Session(apiOrigin, decrypt(encryptedToken), userId);
            } catch (GeneralSecurityException | IllegalArgumentException error) {
                preferences.edit().clear().commit();
                return null;
            }
        }
    }

    static void clear(Context context) {
        synchronized (LOCK) {
            preferences(context).edit().clear().commit();
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String encrypt(String value) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + "."
            + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private static String decrypt(String value) throws GeneralSecurityException {
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new GeneralSecurityException("Invalid encrypted session");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private static SecretKey getOrCreateKey() throws GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        try {
            keyStore.load(null);
        } catch (IOException error) {
            throw new GeneralSecurityException("Could not load Android Keystore", error);
        }
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        );
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    static final class Session {
        final String apiOrigin;
        final String authToken;
        final String userId;

        Session(String apiOrigin, String authToken, String userId) {
            this.apiOrigin = apiOrigin;
            this.authToken = authToken;
            this.userId = userId;
        }

        boolean matchesUser(String candidateUserId) {
            return userId.equals(candidateUserId);
        }
    }
}
