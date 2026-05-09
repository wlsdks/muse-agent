import {
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";

export function createAuthService(): Auth {
  const userStore = new InMemoryUserStore();
  const provider = new DefaultAuthProvider(userStore);
  return new Auth({
    authProvider: provider,
    jwt: new JwtTokenProvider({ jwtSecret: "0123456789abcdef0123456789abcdef" }),
    userStore
  });
}
