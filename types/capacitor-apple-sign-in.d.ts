declare module '@capawesome/capacitor-apple-sign-in' {
  export enum SignInScope {
    Email = 0,
    FullName = 1,
  }

  export interface SignInResult {
    idToken?: string;
    authorizationCode?: string;
    givenName?: string;
    familyName?: string;
    email?: string;
  }

  export interface SignInOptions {
    scopes?: SignInScope[];
    nonce?: string;
  }

  export const AppleSignIn: {
    signIn(options?: SignInOptions): Promise<SignInResult>;
  };
}
