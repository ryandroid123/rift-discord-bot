require("dotenv").config();
const { REST, Routes } = require("discord.js");
const commands = require("./commands");

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Deploying commands...");
    const result = await Promise.race([
      rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Deploy timed out after 15 seconds")), 15000)
      )
    ]);

    console.log("Commands deployed successfully.", Array.isArray(result) ? result.length : result);
  } catch (err) {
    console.error("DEPLOY ERROR:", err);
  }
})();