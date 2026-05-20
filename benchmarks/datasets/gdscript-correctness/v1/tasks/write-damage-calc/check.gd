## check.gd — validates write-damage-calc solution
## Run via: godot --headless --script check.gd
## Exits 0 on pass, 1 on fail.
extends SceneTree

func _init() -> void:
	var script := load("res://solution-a.gd") as GDScript
	if script == null:
		push_error("FAIL: could not load solution-a.gd")
		quit(1)
		return

	var obj := script.new()

	# No crit: should return base_damage unchanged
	var no_crit := obj.calculate_damage(100.0, 0.0, 2.0)
	if no_crit != 100.0:
		push_error("FAIL: expected 100.0 for no-crit, got %s" % no_crit)
		quit(1)
		return

	# Always crit: should return base * multiplier
	var always_crit := obj.calculate_damage(100.0, 1.0, 2.0)
	if always_crit != 200.0:
		push_error("FAIL: expected 200.0 for always-crit, got %s" % always_crit)
		quit(1)
		return

	print("PASS")
	quit(0)
