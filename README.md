# Anaïs sur WhatsApp

Anaïs répond aussi aux messages privés reçus sur le compte WhatsApp connecté. Elle garde les 20 derniers messages par conversation ainsi que l'historique récent de ses échanges pour mieux suivre les sujets et les personnes. En privé, le contexte est traité comme une conversation entre deux personnes; en groupe, comme un fil à plusieurs participants. Dans les groupes, elle répond quand on la mentionne, quand un message contient une variante de son prénom, quand on répond à l’un de ses messages, ou quand le groupe mentionne `@all` / `@tous`. Les messages reçus en rafale sont regroupés après 1,8 seconde de calme, avec une limite de 5 secondes pour ne pas attendre indéfiniment. Elle transmet à Gemini l’heure et le texte des 20 derniers messages de la conversation afin de suivre le rythme et les références. Après une interpellation, elle reste attentive au groupe pendant 5 minutes et peut rebondir sans nouvelle mention, au plus une fois toutes les 15 secondes. En dehors de cette fenêtre, elle peut rebondir spontanément sur les discussions avec une probabilité minimale de 70 %. Le délai varie selon la conversation : généralement autour de 10 à 20 secondes, environ 10 secondes après une rafale d’au moins trois messages, et jusqu’à 60 secondes si la personne a elle-même tardé à répondre. Les messages programmés conservent leurs horaires. Le terminal indique si elle prépare une réponse ou pourquoi elle garde le silence.

Elle peut analyser les images et les audios reçus, dans la limite de 10 Mo par média. Leur contenu est transmis à l’API Gemini pour générer une réponse ; ne partagez donc pas de média sensible avec le bot.

## Assistance et génération d’images

En privé, le propriétaire peut demander de l’aide sur le Génie informatique, la programmation, ses projets, l’organisation et la rédaction. Anaïs reste étudiante en GRH dans son personnage. Elle peut évoquer Congolibs et solliciter un avis seulement quand le sujet touche l’apprentissage, les études, les ressources scolaires ou les plateformes éducatives, au plus une fois par conversation récente : https://congolibs.netlify.app/. Pour générer une image, configure `CLOUDFLARE_ACCOUNT_ID` et `CLOUDFLARE_API_TOKEN`, puis envoie `/image description de l’image` en privé. Le bot utilise FLUX.1 schnell via Cloudflare Workers AI et renvoie l’image dans WhatsApp. La génération est facultative : si l’API n’est pas configurée ou échoue, le bot reste silencieux. Le forfait gratuit Cloudflare Workers AI comprend 10 000 Neurons par jour ; une fois la limite atteinte, les requêtes échouent jusqu’à la remise à zéro, sauf passage à une offre payante.

## Messages autonomes programmés

Quand le processus est actif et connecté à WhatsApp, Anaïs envoie une salutation dans chaque groupe autorisé à 9 h et à 12 h, heure de Brazzaville. À midi, elle envoie aussi au plus un petit message privé par jour à chaque membre de ses groupes. Les textes sont choisis dans de courtes variantes pour éviter les appels API supplémentaires. Avec Render Free, ces horaires sont au mieux effort : le service peut se mettre en veille après 15 minutes sans trafic et manquer l’envoi. Les envois privés dépendent aussi des paramètres de confidentialité des destinataires.

## Démarrage

1. Installe Node.js 20 ou plus récent.
2. Dans ce dossier, lance `npm install`.
3. Copie `.env.example` vers `.env` et renseigne `GEMINI_API_KEY`, `ANAIS_OWNER_NAME` et `ANAIS_OWNER_NUMBER`. Crée ta clé Gemini dans Google AI Studio.
4. Lance `npm start`.
5. Scanne le QR affiché avec WhatsApp > Appareils connectés.

La session WhatsApp est conservée dans `auth_info`. Ne partage pas ce dossier ni le fichier `.env`. Pour limiter Anaïs à des groupes précis, ajoute leurs identifiants séparés par des virgules dans `WHATSAPP_GROUPS`.

Baileys est une bibliothèque communautaire non officielle. La première connexion nécessite un QR valide et une connexion internet active.

## Déploiement Render Free

Le fichier `render.yaml` prépare un service Web gratuit et `/health` permet à Render de vérifier que le processus tourne. Dans Render, connecte le dépôt GitHub, choisis **New > Blueprint**, puis renseigne `GEMINI_API_KEY` dans les variables secrètes avant le premier déploiement. Pour un service Render créé manuellement, ajoute séparément ses variables dans **Environment** : `QR_VIEW_PASSWORD`, `CLOUDFLARE_ACCOUNT_ID` et `CLOUDFLARE_API_TOKEN`. Pour lier WhatsApp sur Render, ajoute aussi la variable secrète `QR_VIEW_PASSWORD` dans **Environment** (choisis un mot de passe long et unique), puis redéploie. Ouvre ensuite `https://<URL-DU-SERVICE>/qr` : le navigateur demandera l’utilisateur `anais` et le mot de passe `QR_VIEW_PASSWORD`, puis affichera le QR sous forme d’image. Scanne-le avec WhatsApp > Appareils connectés. La page ne montre le QR qu’en attente et ne le conserve pas après connexion.

Render Free peut mettre le service en veille après une période sans trafic et son système de fichiers est temporaire. Le dossier `auth_info` est donc perdu lors d'une veille, d'un redémarrage ou d'un nouveau déploiement ; il peut alors falloir relier WhatsApp en rescannant un QR. Ce plan ne garantit pas une connexion permanente ni la conservation de la session. L'offre gratuite ne fournit pas de disque persistant.
