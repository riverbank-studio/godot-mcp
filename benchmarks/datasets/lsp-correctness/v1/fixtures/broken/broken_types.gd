## Intentionally broken script: type errors for diagnostics fixture.
##
## This file is kept in fixtures/broken/ and is NOT part of the
## playable project.  It is opened by the harness specifically to
## exercise godot_get_diagnostics against known errors.
##
## Known errors:
##   Line 19 — assigning String to int variable (type mismatch)
##   Line 23 — calling undeclared function `nonexistent_func`
extends Node

var count: int = 0

func _ready() -> void:
	# ERROR: Cannot assign String to int.
	count = "not_an_int"

	# ERROR: Identifier 'nonexistent_func' not declared in current scope.
	nonexistent_func()
