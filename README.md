# Anaïs sur WhatsApp

Anaïs répond aussi aux messages privés reçus sur le compte WhatsApp connecté. Elle garde les 20 derniers messages par conversation ainsi que l'historique récent de ses échanges pour mieux suivre les sujets et les personnes. En privé, le contexte est traité comme une conversation entre deux personnes; en groupe, comme un fil à plusieurs participants. Dans les groupes, elle répond quand on la mentionne, quand un message contient une variante de son prénom, quand on répond à l’un de ses messages, ou quand le groupe mentionne `@all` / `@tous`. Les messages reçus en rafale sont regroupés pendant environ 1,2 seconde et elle choisit un message pertinent auquel répondre. Elle peut rebondir spontanément sur les discussions (45 % des lots admissibles, au plus une fois toutes les 30 secondes par groupe) et mentionne alors l’auteur concerné. Le délai est généralement de 0,8 à 1,8 seconde après le regroupement. Le terminal indique si elle prépare une réponse ou pourquoi elle garde le silence.

Elle peut analyser les images et les audios reçus, dans la limite de 10 Mo par média. Leur contenu est transmis à l’API Gemini pour générer une réponse ; ne partagez donc pas de média sensible avec le bot.

## Démarrage

1. Installe Node.js 20 ou plus récent.
2. Dans ce dossier, lance `npm install`.
3. Copie `.env.example` vers `.env` et renseigne `GEMINI_API_KEY`, `ANAIS_OWNER_NAME` et `ANAIS_OWNER_NUMBER`. Crée ta clé Gemini dans Google AI Studio.
4. Lance `npm start`.
5. Scanne le QR affiché avec WhatsApp > Appareils connectés.

La session WhatsApp est conservée dans `auth_info`. Ne partage pas ce dossier ni le fichier `.env`. Pour limiter Anaïs à des groupes précis, ajoute leurs identifiants séparés par des virgules dans `WHATSAPP_GROUPS`.

Baileys est une bibliothèque communautaire non officielle. La première connexion nécessite un QR valide et une connexion internet active.

## Déploiement Render Free

Le fichier `render.yaml` prépare un service Web gratuit et `/health` permet à Render de vérifier que le processus tourne. Dans Render, connecte le dépôt GitHub, choisis **New > Blueprint**, puis renseigne `GEMINI_API_KEY` dans les variables secrètes avant le premier déploiement. Pour lier WhatsApp sur Render, ajoute aussi la variable secrète `QR_VIEW_PASSWORD` dans **Environment** (choisis un mot de passe long et unique), puis redéploie. Ouvre ensuite `https://<URL-DU-SERVICE>/qr` : le navigateur demandera l’utilisateur `anais` et le mot de passe `QR_VIEW_PASSWORD`, puis affichera le QR sous forme d’image. Scanne-le avec WhatsApp > Appareils connectés. La page ne montre le QR qu’en attente et ne le conserve pas après connexion.

Render Free peut mettre le service en veille après une période sans trafic et son système de fichiers est temporaire. Le dossier `auth_info` est donc perdu lors d'une veille, d'un redémarrage ou d'un nouveau déploiement ; il peut alors falloir relier WhatsApp en rescannant un QR. Ce plan ne garantit pas une connexion permanente ni la conservation de la session. L'offre gratuite ne fournit pas de disque persistant.
