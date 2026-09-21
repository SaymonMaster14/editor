/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Router, HashRouter, Route, useLocation } from '@solidjs/router';
import { ColorModeProvider } from '@kobalte/core';
import { Show, createEffect, type JSX } from 'solid-js';
import { Toaster } from "@/components/ui/sonner";
import { AppContextMenu } from "@/components/app-context-menu";

import { AuthProvider, useAuth } from '@/context/auth';
import { PersistRoute } from '@/lib/persist-route';
import { EditorApi } from '@/dapi';
import { UpgradeDialog } from '@/components/upgrade-dialog';
import { PurchaseSuccess } from '@/components/purchase-success';
import { ScreenTooSmall } from '@/components/screen-too-small';
import { UnsupportedBrowser } from '@/components/unsupported-browser';
import { ProjectPage } from '@/pages/project';
import { LoginPage } from '@/pages/login';
import { AuthCallbackPage } from '@/pages/auth-callback';
import { NotFoundPage } from '@/pages/not-found';
import { DashboardPage } from '@/pages/dashboard';

function AuthGate(props: { children: JSX.Element }) {
  const auth = useAuth();
  // DEV ONLY, compiled out of production builds (import.meta.env.DEV is
  // statically false there): ?no-auth lets a headless dev instance open
  // local projects for dapi validation with no signed-in user. Set by the
  // main process from DIFFUSION_DEV_NO_AUTH; never honored when packaged.
  const devNoAuth = () => import.meta.env.DEV && window.desktop && new URLSearchParams(window.location.search).has("no-auth");

  return (
    <Show when={!auth.isLoading()}>
      <Show when={auth.isAuthenticated() || devNoAuth()}>
        {props.children}
      </Show>
      <Show when={!auth.isAuthenticated() && !devNoAuth()}>
        <LoginPage />
      </Show>
    </Show>
  );
}

function BootSplash() {
  const auth = useAuth();

  createEffect(() => {
    if (auth.isLoading()) return;
    document.getElementById('boot-splash')?.remove();
  });

  return null;
}

function EnvironmentOverlays() {
  const location = useLocation();
  const onCheckoutPage = () => location.pathname.startsWith('/checkout');

  return (
    <Show when={!onCheckoutPage()}>
      <ScreenTooSmall />
      <UnsupportedBrowser />
    </Show>
  );
}

function App() {
  const RouterComponent = window.desktop ? HashRouter : Router;
  return (
    <RouterComponent
      root={(props) => (
        <ColorModeProvider initialColorMode="dark">
          <AppContextMenu>
            <AuthProvider>
              {props.children}
              <BootSplash />
              <UpgradeDialog />
              <PurchaseSuccess />
              <EditorApi />
            </AuthProvider>
          </AppContextMenu>
          <Toaster />
          <EnvironmentOverlays />
          <PersistRoute />
        </ColorModeProvider>
      )}
    >
      <Route path="/auth/callback" component={AuthCallbackPage} />
      <Route path="/" component={() => <AuthGate><DashboardPage /></AuthGate>} />
      <Route path="/projects/*ref" component={() => <AuthGate><ProjectPage /></AuthGate>} />
      <Route path="*404" component={NotFoundPage} />
    </RouterComponent>
  );
}

export default App;
