# Utiliser une version légère de Node.js
FROM node:20-alpine

# Créer le dossier de l'application
WORKDIR /app

# Copier les fichiers de dépendances
COPY package.json ./

# Installer les dépendances
# "npm ci" est plus fiable pour la prod, mais "npm install" marche aussi
RUN npm install

# Copier le reste du code source
COPY . .

# Exposer le port (Coolify en a besoin pour savoir où écouter)
EXPOSE 3000

# Commande de démarrage
CMD ["node", "server.js"]