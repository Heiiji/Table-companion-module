/**
 * The Knight Compendium 14.0.1 document each catalog weapon is copied from by
 * `actor.items.v1`: the one that carries the weapon's first attack (a weapon the
 * compendium keeps as two documents, one per range, maps to its first mode).
 * Identities only; verified against tag 14.0.1 at commit
 * a7c06e20245247752b5d350f8252a8b89ddeed9c. The creation crosswalk
 * (`knightCompendiumCrosswalkV14_0_1.ts`) is separate and unchanged.
 */
export const KNIGHT_WEAPON_CROSSWALK_V14_0_1: Readonly<
  Record<string, { pack: string; documentId: string }>
> = {
  "knight.weapon.pistolet-de-service": {
    pack: "knight-compendium.weapons-standard",
    documentId: "df9dd63546eda43e",
  },
  "knight.weapon.shotgun-escamotable": {
    pack: "knight-compendium.weapons-standard",
    documentId: "9e6924b375d1b2bc",
  },
  "knight.weapon.fusil-dassaut": {
    pack: "knight-compendium.weapons-standard",
    documentId: "3471977efdf10002",
  },
  "knight.weapon.pistolet-mitrailleur": {
    pack: "knight-compendium.weapons-standard",
    documentId: "62be65b080418e07",
  },
  "knight.weapon.fusil-de-precision": {
    pack: "knight-compendium.weapons-standard",
    documentId: "f76b17830826ba92",
  },
  "knight.weapon.lance-grenade-leger": {
    pack: "knight-compendium.weapons-standard",
    documentId: "0c47b61b2d78f3bc",
  },
  "knight.weapon.morgenstern": {
    pack: "knight-compendium.weapons-standard",
    documentId: "e33ef6366b61fb23",
  },
  "knight.weapon.marteau-epieu": {
    pack: "knight-compendium.weapons-standard",
    documentId: "62a75eda8200a5e8",
  },
  "knight.weapon.couteau-de-combat": {
    pack: "knight-compendium.weapons-standard",
    documentId: "a02e4ffc8ec4f1eb",
  },
  "knight.weapon.ceste-lourd": {
    pack: "knight-compendium.weapons-standard",
    documentId: "ef56836e96882724",
  },
  "knight.weapon.epee-batarde": {
    pack: "knight-compendium.weapons-standard",
    documentId: "18e9b939fbd53d17",
  },
  "knight.weapon.bouclier-amovible": {
    pack: "knight-compendium.weapons-standard",
    documentId: "f0f7ec5d55a69c6f",
  },
  "knight.weapon.lance-missile": {
    pack: "knight-compendium.weapons-avance",
    documentId: "RqcFLHhAOZQ7xQDb",
  },
  "knight.weapon.mitrailleuse-lourde": {
    pack: "knight-compendium.weapons-avance",
    documentId: "53b6HFXHNYMAgOR1",
  },
  "knight.weapon.pistolet-dinfiltration": {
    pack: "knight-compendium.weapons-avance",
    documentId: "BjzowSIdz05Ckm9s",
  },
  "knight.weapon.lance-grenade-lourd": {
    pack: "knight-compendium.weapons-avance",
    documentId: "VqK42Xr17qspD27S",
  },
  "knight.weapon.fusil-anti-materiel": {
    pack: "knight-compendium.weapons-avance",
    documentId: "CRS6DOWZori7imSa",
  },
  "knight.weapon.shotgun-automatique": {
    pack: "knight-compendium.weapons-avance",
    documentId: "IEmwIIJ9O37gTSpK",
  },
  "knight.weapon.ceste-repulsif": {
    pack: "knight-compendium.weapons-avance",
    documentId: "gKUcqNy1LS66r3Qk",
  },
  "knight.weapon.epee-longue": {
    pack: "knight-compendium.weapons-avance",
    documentId: "iLpUpxweb9AdKnDN",
  },
  "knight.weapon.dague": {
    pack: "knight-compendium.weapons-avance",
    documentId: "dkW6POTAPe9l5csq",
  },
  "knight.weapon.belier-a-piston": {
    pack: "knight-compendium.weapons-avance",
    documentId: "ajDYsyHiPjlV0HUe",
  },
  "knight.weapon.matraques-electriques": {
    pack: "knight-compendium.weapons-avance",
    documentId: "b5CRpLOXt4JccAPv",
  },
  "knight.weapon.sabre-brulant": {
    pack: "knight-compendium.weapons-avance",
    documentId: "kJWSdng4NHkLBTmB",
  },
  "knight.weapon.targe-amovible": {
    pack: "knight-compendium.weapons-avance",
    documentId: "OVdrZGTMNnWmJNZ8",
  },
  "knight.weapon.fleau-repulsif": {
    pack: "knight-compendium.weapons-avance",
    documentId: "mZOkug4D3NGiBrqt",
  },
  "knight.weapon.torche-plasma": {
    pack: "knight-compendium.weapons-avance",
    documentId: "SkLEgZrkETUt0Sjq",
  },
  "knight.weapon.revolver-lourd": {
    pack: "knight-compendium.weapons-rare",
    documentId: "93aaf9881cdcd09b",
  },
  "knight.weapon.fusil-laser": {
    pack: "knight-compendium.weapons-rare",
    documentId: "90bcde6b02f365b6",
  },
  "knight.weapon.arbalete-magnetique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "121348a6090f38b4",
  },
  "knight.weapon.shotgun-auto-lourd": {
    pack: "knight-compendium.weapons-rare",
    documentId: "69d16505712c021d",
  },
  "knight.weapon.lance-flammes": {
    pack: "knight-compendium.weapons-rare",
    documentId: "1cec7557b4d15010",
  },
  "knight.weapon.railgun": {
    pack: "knight-compendium.weapons-rare",
    documentId: "58ae79bc821a314f",
  },
  "knight.weapon.hache-a-reaction": {
    pack: "knight-compendium.weapons-rare",
    documentId: "314e155d8b406db8",
  },
  "knight.weapon.pavois": {
    pack: "knight-compendium.weapons-rare",
    documentId: "699223ab4d42e4a9",
  },
  "knight.weapon.epee-lumiere": {
    pack: "knight-compendium.weapons-rare",
    documentId: "292185629cc75c5f",
  },
  "knight.weapon.epee-cinetique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "005106924e02b7c5",
  },
  "knight.weapon.masse-magnetique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "31020f7af7a1d200",
  },
  "knight.weapon.ceste-de-fracture": {
    pack: "knight-compendium.weapons-rare",
    documentId: "2361d79c38e2c72e",
  },
  "knight.weapon.epee-sonique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "68b4a43786470690",
  },
  "knight.weapon.matraque-taser": {
    pack: "knight-compendium.weapons-standard",
    documentId: "36d5897545abc4f8",
  },
  "knight.weapon.pistolet-connecte": {
    pack: "knight-compendium.weapons-standard",
    documentId: "564ed4c4931059af",
  },
  "knight.weapon.pistolet-de-precision": {
    pack: "knight-compendium.weapons-standard",
    documentId: "75583ef07d468757",
  },
  "knight.weapon.hache-de-combat": {
    pack: "knight-compendium.weapons-standard",
    documentId: "5903834c3bbbeb6a",
  },
  "knight.weapon.lance-perforante-a-piston": {
    pack: "knight-compendium.weapons-standard",
    documentId: "2cd3f9b543f9aa86",
  },
  "knight.weapon.shotgun-automatique-leger": {
    pack: "knight-compendium.weapons-avance",
    documentId: "Ok6GcCfOxmkGin4K",
  },
  "knight.weapon.baton-de-combat": {
    pack: "knight-compendium.weapons-avance",
    documentId: "oEMCeU8E2dLr1ScR",
  },
  "knight.weapon.cimeterre-cinetique": {
    pack: "knight-compendium.weapons-avance",
    documentId: "Xl07YhgIVqQdPYFu",
  },
  "knight.weapon.ceste-shotgun": {
    pack: "knight-compendium.weapons-avance",
    documentId: "gnNvk02R1AngjIbl",
  },
  "knight.weapon.trident-machoire": {
    pack: "knight-compendium.weapons-avance",
    documentId: "sXYmNiFMj7pJOFzQ",
  },
  "knight.weapon.paire-de-pistolets-ouragan": {
    pack: "knight-compendium.weapons-rare",
    documentId: "1868304a6711c069",
  },
  "knight.weapon.stylet-thermique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "7393c658f3838219",
  },
  "knight.weapon.lance-thermique": {
    pack: "knight-compendium.weapons-rare",
    documentId: "fe08ed4014712c3a",
  },
  "knight.weapon.chaine-tronconneuse": {
    pack: "knight-compendium.weapons-rare",
    documentId: "44fb61ee52ef3dfe",
  },
  "knight.weapon.coups": {
    pack: "knight-compendium.weapons-standard",
    documentId: "e3c2ed71294dc29a",
  },
  "knight.weapon.fusil-sonique": {
    pack: "knight-compendium.weapons-avance",
    documentId: "7tMkfOj63SRJ2r6w",
  },
  "knight.weapon.canon-concussion": {
    pack: "knight-compendium.weapons-rare",
    documentId: "d3a6b52076292422",
  },
  "knight.weapon.ceste-concussion": {
    pack: "knight-compendium.weapons-avance",
    documentId: "6gdDqDrZglx2mtyh",
  },
  "knight.weapon.fusil-uv": {
    pack: "knight-compendium.weapons-avance",
    documentId: "1wm4Vf9baj7wpSJG",
  },
  "knight.weapon.canon-uv": {
    pack: "knight-compendium.weapons-rare",
    documentId: "385d01ce83c89ed1",
  },
  "knight.weapon.lance-de-lumiere": {
    pack: "knight-compendium.weapons-avance",
    documentId: "qcqyhw6jguQmAQXV",
  },
  "knight.weapon.epee-du-sacre-de-charlemagne": {
    pack: "knight-compendium.weapons-espoir",
    documentId: "5447033b86de57de",
  },
  "knight.weapon.premiere-grande-lance-du-japon": {
    pack: "knight-compendium.weapons-espoir",
    documentId: "056d04bfc40b5383",
  },
  "knight.weapon.griffes-de-fenrir": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "28ba5b2fb9bed7f2",
  },
  "knight.weapon.chaine-epee-wyvern": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "4dfc2d52a17fa0e4",
  },
  "knight.weapon.marteau-cinetique-typhon": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "112845c28cdd5aef",
  },
  "knight.weapon.pulseur-alpha": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "954402429d33e63f",
  },
  "knight.weapon.canon-nova": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "02fce8711b40801e",
  },
  "knight.weapon.seth-canon-intelligent-munition-drones": {
    pack: "knight-compendium.weapons-prestige",
    documentId: "db48239933b039c0",
  },
  "knight.weapon.pistolet-polycalibre": {
    pack: "knight-compendium.adl-armes-1-standard",
    documentId: "VSCCX2zEIZ0gXjzT",
  },
  "knight.weapon.lame-polymorphique": {
    pack: "knight-compendium.adl-armes-1-standard",
    documentId: "t1xJY3DUD0fDZdTj",
  },
};
