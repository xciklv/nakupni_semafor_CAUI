# Souhrn měření (generováno analyze.js)

| běh | volání | chyby | přesnost verdiktu | problém×OK | falešný poplach | přehlédnuto | konzistence | USD celkem | USD/volání | výstup tok. | latence med. s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-haiku-5-5-P0 | 42 | 0 | 88 % | 95 % | 13 % (2/15) | 0 % (0/27) | – | 0.0165 | 0.00039 | 720 | 4.4 |
| claude-haiku-5-5-P1 | 126 | 0 | 90 % | 96 % | 9 % (4/45) | 1 % (1/81) | 76 % (32/42 případů, verdikt shodný ve všech během) | 0.0449 | 0.00036 | 638 | 4 |
| claude-haiku-5-5-P1 [jen běh 1] | 42 | 0 | 93 % | 100 % | 0 % (0/15) | 0 % (0/27) | – | 0.015 | 0.00036 | 634 | 4.1 |
| claude-opus-5-5-P1 | 4 | 0 | 25 % | 100 % | 0 % (0/1) | 0 % (0/3) | – | 0.0713 | 0.01784 | 687 | 8.7 |
| claude-sonnet-5-5-P1 | 58 | 0 | 83 % | 100 % | 0 % (0/23) | 0 % (0/35) | 100 % (8/8 případů, verdikt shodný ve všech během) | 0.446 | 0.00769 | 690 | 7.2 |
| claude-sonnet-5-5-P1 [jen běh 1] | 42 | 0 | 90 % | 100 % | 0 % (0/15) | 0 % (0/27) | – | 0.3207 | 0.00763 | 681 | 6.9 |

## claude-haiku-5-5-P0

Matice očekávané→dostal: nepravdepodobne→nepravdepodobne=4, nepravdepodobne→nesmysl=3, nesmysl→nesmysl=20, v_poradku→nepravdepodobne=1, v_poradku→nesmysl=1, v_poradku→v_poradku=13

Vždy špatně: kabel-60w-3a-ok (čekáno v_poradku, dostal nesmysl); nabijecka-65w-ok (čekáno v_poradku, dostal nepravdepodobne); solar-200w-05m2 (čekáno nepravdepodobne, dostal nesmysl); ebike-250km (čekáno nepravdepodobne, dostal nesmysl); hodinky-30-dni-amoled (čekáno nepravdepodobne, dostal nesmysl)

## claude-haiku-5-5-P1

Matice očekávané→dostal: nepravdepodobne→nepravdepodobne=13, nepravdepodobne→nesmysl=7, nepravdepodobne→v_poradku=1, nesmysl→nepravdepodobne=1, nesmysl→nesmysl=59, v_poradku→nepravdepodobne=4, v_poradku→v_poradku=41

Nestabilní případy: celovka-1000-ok: v_poradku/nepravdepodobne/v_poradku; pb-30000-199: nepravdepodobne/v_poradku/nepravdepodobne; nabijecka-65w-ok: v_poradku/v_poradku/nepravdepodobne; karta-microsd-2tb-299: nesmysl/nepravdepodobne/nepravdepodobne; repro-pmpo-20000w: nesmysl/nepravdepodobne/nesmysl; repro-30w-rms-ok: v_poradku/v_poradku/nepravdepodobne; solar-200w-05m2: nesmysl/nesmysl/nepravdepodobne; ebike-250km: nesmysl/nepravdepodobne/nesmysl; hodinky-30-dni-amoled: nepravdepodobne/nesmysl/nesmysl; hodinky-14-dni-ok: v_poradku/v_poradku/nepravdepodobne

## claude-haiku-5-5-P1 [jen běh 1]

Matice očekávané→dostal: nepravdepodobne→nepravdepodobne=4, nepravdepodobne→nesmysl=3, nesmysl→nesmysl=20, v_poradku→v_poradku=15

Vždy špatně: karta-microsd-2tb-299 (čekáno nepravdepodobne, dostal nesmysl); solar-200w-05m2 (čekáno nepravdepodobne, dostal nesmysl); ebike-250km (čekáno nepravdepodobne, dostal nesmysl)

## claude-opus-5-5-P1

Matice očekávané→dostal: nepravdepodobne→nesmysl=3, v_poradku→v_poradku=1

Vždy špatně: ebike-250km (čekáno nepravdepodobne, dostal nesmysl); pb-30000-199 (čekáno nepravdepodobne, dostal nesmysl); karta-microsd-2tb-299 (čekáno nepravdepodobne, dostal nesmysl)

## claude-sonnet-5-5-P1

Matice očekávané→dostal: nepravdepodobne→nepravdepodobne=5, nepravdepodobne→nesmysl=10, nesmysl→nesmysl=20, v_poradku→v_poradku=23

Vždy špatně: pb-30000-199 (čekáno nepravdepodobne, dostal nesmysl/nesmysl/nesmysl); karta-microsd-2tb-299 (čekáno nepravdepodobne, dostal nesmysl/nesmysl/nesmysl); solar-200w-05m2 (čekáno nepravdepodobne, dostal nesmysl); ebike-250km (čekáno nepravdepodobne, dostal nesmysl/nesmysl/nesmysl)

## claude-sonnet-5-5-P1 [jen běh 1]

Matice očekávané→dostal: nepravdepodobne→nepravdepodobne=3, nepravdepodobne→nesmysl=4, nesmysl→nesmysl=20, v_poradku→v_poradku=15

Vždy špatně: pb-30000-199 (čekáno nepravdepodobne, dostal nesmysl); karta-microsd-2tb-299 (čekáno nepravdepodobne, dostal nesmysl); solar-200w-05m2 (čekáno nepravdepodobne, dostal nesmysl); ebike-250km (čekáno nepravdepodobne, dostal nesmysl)
