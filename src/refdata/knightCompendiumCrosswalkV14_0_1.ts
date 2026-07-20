/**
 * Exact, fail-closed equipment identities for Knight Compendium 14.0.1.
 *
 * Only package/pack/document identities and Foundry Item types are retained
 * here. The source documents themselves remain in the optional compendium.
 * The fixture was verified against tag 14.0.1 at commit
 * a7c06e20245247752b5d350f8252a8b89ddeed9c.
 */
export const KNIGHT_COMPENDIUM_MODULE_ID = "knight-compendium";
export const KNIGHT_COMPENDIUM_VERSION = "14.0.1";
export const KNIGHT_COMPENDIUM_SOURCE_COMMIT =
  "a7c06e20245247752b5d350f8252a8b89ddeed9c";

export interface KnightEquipmentCrosswalkDocumentV1 {
  pack: string;
  documentId: string;
  itemType: "armure" | "arme" | "module";
  /** Module levels share one Foundry Item; the selected highest level is set on import. */
  moduleFamilyId?: string;
  moduleLevel?: 1 | 2 | 3;
}

type Entry = readonly KnightEquipmentCrosswalkDocumentV1[];

const armour = (documentId: string): Entry => [
  {
    pack: "knight-compendium.armours-base",
    documentId,
    itemType: "armure",
  },
];

const weapon = (...documentIds: string[]): Entry =>
  documentIds.map((documentId) => ({
    pack: "knight-compendium.weapons-standard",
    documentId,
    itemType: "arme" as const,
  }));

const moduleLevel = (
  moduleFamilyId: string,
  documentId: string,
  level: 1 | 2 | 3,
): Entry => [
  {
    pack: "knight-compendium.modules-standard",
    documentId,
    itemType: "module",
    moduleFamilyId,
    moduleLevel: level,
  },
];

export const KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1: Readonly<
  Record<string, Entry>
> = {
  "knight.armour.warrior": armour("22826f541c384281"),
  "knight.armour.paladin": armour("add808cf4f4dcdc1"),
  "knight.armour.priest": armour("dcd73012a30f598a"),
  "knight.armour.warmaster": armour("ef3cb5fb9e65fb04"),
  "knight.armour.rogue": armour("ab4ca364b78e8d5d"),
  "knight.armour.ranger": armour("d5a5978cc4f2bc33"),
  "knight.armour.bard": armour("9268f377d44809a2"),
  "knight.armour.wizard": armour("5463cd447204b6e0"),
  "knight.armour.barbarian": armour("640288b9621eef7b"),

  "knight.weapon.pistolet-de-service": weapon(
    "df9dd63546eda43e",
    "448e9e2430dceff8",
  ),
  "knight.weapon.shotgun-escamotable": weapon("9e6924b375d1b2bc"),
  "knight.weapon.fusil-dassaut": weapon("3471977efdf10002"),
  "knight.weapon.pistolet-mitrailleur": weapon("62be65b080418e07"),
  "knight.weapon.fusil-de-precision": weapon("f76b17830826ba92"),
  "knight.weapon.lance-grenade-leger": weapon("0c47b61b2d78f3bc"),
  "knight.weapon.morgenstern": weapon("e33ef6366b61fb23"),
  "knight.weapon.marteau-epieu": weapon("62a75eda8200a5e8", "1495ae299d871c7a"),
  "knight.weapon.couteau-de-combat": weapon("a02e4ffc8ec4f1eb"),
  "knight.weapon.ceste-lourd": weapon("ef56836e96882724"),
  "knight.weapon.epee-batarde": weapon("18e9b939fbd53d17"),
  "knight.weapon.bouclier-amovible": weapon(
    "f0f7ec5d55a69c6f",
    "d0fa1e9b5b8f3e45",
  ),

  "knight.module.saut.l1": moduleLevel(
    "knight.module.saut",
    "sXd50IHvgwvC3R5k",
    1,
  ),
  "knight.module.saut.l2": moduleLevel(
    "knight.module.saut",
    "sXd50IHvgwvC3R5k",
    2,
  ),
  "knight.module.saut.l3": moduleLevel(
    "knight.module.saut",
    "sXd50IHvgwvC3R5k",
    3,
  ),
  "knight.module.moto-steed.l1": moduleLevel(
    "knight.module.moto-steed",
    "5bhOQ0IhfRW9ntWz",
    1,
  ),
  "knight.module.course.l1": moduleLevel(
    "knight.module.course",
    "ANKh0C0vo1XMSiOs",
    1,
  ),
  "knight.module.course.l2": moduleLevel(
    "knight.module.course",
    "ANKh0C0vo1XMSiOs",
    2,
  ),
  "knight.module.course.l3": moduleLevel(
    "knight.module.course",
    "ANKh0C0vo1XMSiOs",
    3,
  ),
  "knight.module.wingsuit.l1": moduleLevel(
    "knight.module.wingsuit",
    "zGL4YpFHZ6gykV7B",
    1,
  ),
  "knight.module.griffes-de-combat.l1": moduleLevel(
    "knight.module.griffes-de-combat",
    "13wnCjDZZkTZvApX",
    1,
  ),
  "knight.module.griffes-de-combat.l2": moduleLevel(
    "knight.module.griffes-de-combat",
    "13wnCjDZZkTZvApX",
    2,
  ),
  "knight.module.griffes-de-combat.l3": moduleLevel(
    "knight.module.griffes-de-combat",
    "13wnCjDZZkTZvApX",
    3,
  ),
  "knight.module.attaque-sur-casque.l1": moduleLevel(
    "knight.module.attaque-sur-casque",
    "u6kp1AQUnt5KkfYd",
    1,
  ),
  "knight.module.attaque-sur-casque.l2": moduleLevel(
    "knight.module.attaque-sur-casque",
    "u6kp1AQUnt5KkfYd",
    2,
  ),
  "knight.module.lame-de-bras.l1": moduleLevel(
    "knight.module.lame-de-bras",
    "t6oun2RXIjfE3ojo",
    1,
  ),
  "knight.module.lame-de-bras.l2": moduleLevel(
    "knight.module.lame-de-bras",
    "t6oun2RXIjfE3ojo",
    2,
  ),
  "knight.module.lame-de-bras.l3": moduleLevel(
    "knight.module.lame-de-bras",
    "t6oun2RXIjfE3ojo",
    3,
  ),
  "knight.module.attaque-non-letale.l1": moduleLevel(
    "knight.module.attaque-non-letale",
    "Fzm6OiRUOLhvkqkb",
    1,
  ),
  "knight.module.attaque-non-letale.l2": moduleLevel(
    "knight.module.attaque-non-letale",
    "Fzm6OiRUOLhvkqkb",
    2,
  ),
  "knight.module.attaque-non-letale.l3": moduleLevel(
    "knight.module.attaque-non-letale",
    "Fzm6OiRUOLhvkqkb",
    3,
  ),
  "knight.module.grappin.l1": moduleLevel(
    "knight.module.grappin",
    "pVuK7Fz1EvjW1ks0",
    1,
  ),
  "knight.module.canon-balder.l1": moduleLevel(
    "knight.module.canon-balder",
    "JVGoAuTwScCj5ShS",
    1,
  ),
  "knight.module.vue-alternative.l1": moduleLevel(
    "knight.module.vue-alternative",
    "U4RzudpmDIOYaxpW",
    1,
  ),
  "knight.module.vue-alternative.l2": moduleLevel(
    "knight.module.vue-alternative",
    "U4RzudpmDIOYaxpW",
    2,
  ),
  "knight.module.vue-alternative.l3": moduleLevel(
    "knight.module.vue-alternative",
    "U4RzudpmDIOYaxpW",
    3,
  ),
  "knight.module.designation.l1": moduleLevel(
    "knight.module.designation",
    "cJwkffUc4YSKHcHR",
    1,
  ),
  "knight.module.designation.l2": moduleLevel(
    "knight.module.designation",
    "cJwkffUc4YSKHcHR",
    2,
  ),
  "knight.module.designation.l3": moduleLevel(
    "knight.module.designation",
    "cJwkffUc4YSKHcHR",
    3,
  ),
  "knight.module.fumigene.l1": moduleLevel(
    "knight.module.fumigene",
    "gPoF8LiVSQTRhXfi",
    1,
  ),
  "knight.module.flash.l1": moduleLevel(
    "knight.module.flash",
    "KtPM3fkaucqgb3le",
    1,
  ),
  "knight.module.relais-satellite.l1": moduleLevel(
    "knight.module.relais-satellite",
    "zsdGLHrKfLkg2BNA",
    1,
  ),
  "knight.module.relais-satellite.l2": moduleLevel(
    "knight.module.relais-satellite",
    "zsdGLHrKfLkg2BNA",
    2,
  ),
  "knight.module.relais-satellite.l3": moduleLevel(
    "knight.module.relais-satellite",
    "zsdGLHrKfLkg2BNA",
    3,
  ),
  "knight.module.cameraman.l1": moduleLevel(
    "knight.module.cameraman",
    "rd5eFuSwcLKt5jX0",
    1,
  ),
  "knight.module.relais-taccom.l1": moduleLevel(
    "knight.module.relais-taccom",
    "HcnnSwhgTzJMb6UL",
    1,
  ),
  "knight.module.pod-fusees-eclairantes.l1": moduleLevel(
    "knight.module.pod-fusees-eclairantes",
    "MilQjCQMdKdVZOft",
    1,
  ),
  "knight.module.pod-fusees-eclairantes.l2": moduleLevel(
    "knight.module.pod-fusees-eclairantes",
    "MilQjCQMdKdVZOft",
    2,
  ),
  "knight.module.pod-fusees-eclairantes.l3": moduleLevel(
    "knight.module.pod-fusees-eclairantes",
    "MilQjCQMdKdVZOft",
    3,
  ),
  "knight.module.interface-sensitive-rigg.l1": moduleLevel(
    "knight.module.interface-sensitive-rigg",
    "PEcPwwkf09311pYX",
    1,
  ),
  "knight.module.voyager.l1": moduleLevel(
    "knight.module.voyager",
    "JsOCjpRbg7IzVLVp",
    1,
  ),
  "knight.module.tourelle-automatisee.l1": moduleLevel(
    "knight.module.tourelle-automatisee",
    "zzjdfE2aJNpCENdk",
    1,
  ),
};
